// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEPLOY LIFECYCLE — the project editor's deployment + run-log transport
// =============================================================================
//
// Everything the .pipe custom editor's DEPLOY surfaces need from the host:
//
//   - the deploy:data snapshot (registry versions, team deployments, roster),
//   - the deployment drawer's message dispatch (deployment:*): mutations ack
//     with deployment:actionResult, fetches push deployment:load — ported
//     from the retired DeploymentProvider,
//   - the run-log DVR transport (logsession:*): real client.log sessions
//     proxied over the message channel, identical to cloud,
//   - the team-scoped task monitors that make the drawer's run state
//     push-driven (per-connection server-side; cleared on reconnect).
//
// Owned by ProjectProvider; scoped per webview where state is per-panel.
// =============================================================================

import type * as vscode from 'vscode';
import type { RocketRideClient } from 'rocketride';
import type { ConnectionManager } from '../../connection/connection';
import { getLogger } from '../../shared/util/output';
import { resolveDeployTeams, mapVersionCards, mapHistoryRows, mapTeamDeploymentRows, mapScheduleRows, teamNameOf, mapDeploymentInfo, wireTeamIdOf } from '../../shared/util/deployMapping';
import type { DeploymentWebviewToHost, DeploymentLoadPayload } from '../types/deployTypes';
import type { LogSessionWebviewToHost } from '../types/logTypes';

// Runtime allowlist for logsession:call — the webview message crosses a
// process boundary, so the typed 'method' union guarantees nothing; only
// these proxy methods may be invoked on the session object.
const LOG_SESSION_METHODS = ['seek', 'getStatus', 'getTrace'] as const;

export class DeployLifecycle {
	private logger = getLogger();

	/** Open run-log sessions per webview, keyed by the bridge's session id.
	    Closed on logsession:close and swept when the panel disposes. */
	private logSessions = new Map<vscode.Webview, Map<string, ReturnType<RocketRideClient['log']['openEventStream']>>>();

	/** Team task monitors registered this connection (key: teamId.projectId). */
	private deployTaskMonitors = new Set<string>();

	constructor(private readonly connectionManager: ConnectionManager) {}

	/**
	 * Drops the task-monitor registration memory. Team task monitors are
	 * per-connection server-side — a reconnect starts clean, so re-register
	 * on the next drawer fetch.
	 */
	clearTaskMonitors(): void {
		this.deployTaskMonitors.clear();
	}

	/**
	 * Register the team-scoped 'task' monitor a deployment drawer relies on.
	 *
	 * The catch-up snapshot + begin/end pushes are what let the drawer track
	 * run state without polling. Registered once per (team, project) per
	 * connection; the registration lives until disconnect — release is
	 * implicit (per-connection server-side), matching the drawer's
	 * open-again-later usage.
	 *
	 * @param teamId - The deployment's team.
	 * @param projectId - The deployed project.
	 */
	private async ensureDeployTaskMonitor(teamId: string, projectId: string): Promise<void> {
		const key = `${teamId}.${projectId}`;
		if (this.deployTaskMonitors.has(key)) return;
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			await client.addMonitor({ projectId, source: '*', teamId }, ['task']);
			this.deployTaskMonitors.add(key);
		} catch (error) {
			this.logger.error(`Registering deploy task monitor for ${key}: ${error}`);
		}
	}

	/**
	 * Dispatches one run-log session message (logsession:*): open/close
	 * manage real `client.log.openEventStream` sessions; seek/getStatus/
	 * getTrace proxy as promise calls; play streams items back as
	 * logsession:event pushes; chapters is a session-independent fetch.
	 * This is the transport that makes the VS Code DVR identical to cloud.
	 *
	 * @param webview - The project panel's webview.
	 * @param projectId - The panel's project identity.
	 * @param message - The incoming typed message.
	 */
	async handleLogSessionMessage(webview: vscode.Webview, projectId: string, message: LogSessionWebviewToHost): Promise<void> {
		let sessions = this.logSessions.get(webview);
		if (!sessions) {
			sessions = new Map();
			this.logSessions.set(webview, sessions);
		}

		switch (message.type) {
			case 'logsession:open': {
				const client = this.requireDeployClient();
				// A reused session id must release its old stream first — the
				// overwrite would otherwise leak the stream and its monitor.
				sessions.get(message.sessionId)?.closeEventStream();
				sessions.set(message.sessionId, client.log.openEventStream({ projectId, source: message.source, ...(message.teamId ? { teamId: message.teamId } : {}) }));
				break;
			}
			case 'logsession:call': {
				const session = sessions.get(message.sessionId);
				try {
					if (!session) throw new Error('Session is closed');
					// The cast on the incoming message gives NO runtime guarantee
					// at this process boundary — gate the dynamic dispatch on the
					// explicit allowlist so only the proxy methods are reachable.
					if (!(LOG_SESSION_METHODS as readonly string[]).includes(message.method)) {
						throw new Error(`Unsupported session method: ${message.method}`);
					}
					const result = await (session[message.method] as (...a: unknown[]) => Promise<unknown>)(...message.args);
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId, result });
				} catch (error) {
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
			case 'logsession:play': {
				const session = sessions.get(message.sessionId);
				try {
					if (!session) throw new Error('Session is closed');
					await session.play(message.pos === null ? undefined : message.pos, message.speed, (item) => {
						webview.postMessage({ type: 'logsession:event', sessionId: message.sessionId, item });
					});
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId });
				} catch (error) {
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
			case 'logsession:pause': {
				sessions.get(message.sessionId)?.pause();
				break;
			}
			case 'logsession:ingest': {
				sessions.get(message.sessionId)?.ingestLive(message.event as never);
				break;
			}
			case 'logsession:close': {
				sessions.get(message.sessionId)?.closeEventStream();
				sessions.delete(message.sessionId);
				break;
			}
			case 'logsession:chapters': {
				try {
					const client = this.requireDeployClient();
					const result = await client.log.chapters({ projectId, source: message.source, ...(message.teamId ? { teamId: message.teamId } : {}) });
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId, result });
				} catch (error) {
					webview.postMessage({ type: 'logsession:result', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
		}
	}

	/**
	 * Closes every run-log session a disposing panel left open.
	 *
	 * @param webview - The disposing panel's webview.
	 */
	disposeLogSessions(webview: vscode.Webview): void {
		const sessions = this.logSessions.get(webview);
		if (!sessions) return;
		for (const session of sessions.values()) session.closeEventStream();
		this.logSessions.delete(webview);
	}

	/**
	 * Dispatches one deployment-drawer message (deployment:*). Mutations run
	 * through the deploy API, ack with deployment:actionResult (the drawer's
	 * pending promise), then re-push a fresh deployment:load so the drawer
	 * reflects the server's truth. Ported from the retired DeploymentProvider;
	 * the drawer replaces its WebviewPanel.
	 *
	 * @param webview - The project panel's webview (drawer host).
	 * @param projectId - The panel's project identity.
	 * @param message - The incoming typed message.
	 */
	async handleDeploymentMessage(webview: vscode.Webview, projectId: string, message: DeploymentWebviewToHost): Promise<void> {
		// Personal rows arrive with their raw 'user~{uid}' owner key — the
		// server only accepts '@me' for the caller's own space, so translate
		// ONCE here and every fetch/action below addresses it correctly.
		const ownUid = this.connectionManager.getClient()?.getAccountInfo?.()?.userId ?? '';
		const teamId = wireTeamIdOf(message.teamId, ownUid);

		switch (message.type) {
			// -- Snapshot (drawer open, push-triggered and post-mutation refresh) --
			case 'deployment:fetch': {
				// The drawer's run state is push-driven from here on: the
				// team-scoped task monitor's events trigger the webview's
				// re-fetches instead of an interval.
				await this.ensureDeployTaskMonitor(teamId, projectId);
				// Echo message.teamId (the RAW row id the drawer opened with) on the
				// pushes so its stale-record guard matches — teamId here is the
				// translated wire id used only for the fetch.
				await this.fetchAndPushDeployment(webview, teamId, projectId, message.sourceId, message.teamId);
				break;
			}

			// -- Disable / enable (the whole-deployment kill switch) --------------
			case 'deployment:setDisabled': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					if (message.disabled) await client.deploy.disable(projectId, teamId);
					else await client.deploy.enable(projectId, teamId);
				});
				break;
			}

			// -- Pointer move (Deploy version… / Rollback alike) ------------------
			case 'deployment:deployVersion': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					await client.deploy.deploy(projectId, message.version, teamId);
				});
				break;
			}

			// -- Soft remove (the drawer closes itself on the resolved ack) -------
			case 'deployment:remove': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					await client.deploy.remove(projectId, teamId);
				});
				break;
			}

			// -- Manual source dispatch (the smoke-test path) ---------------------
			case 'deployment:runSource': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					await client.deploy.run(projectId, message.sourceId, teamId);
				});
				break;
			}

			// -- Stop one source's live run ---------------------------------------
			case 'deployment:stopSource': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					// Existing task machinery: resolve the live task, terminate it.
					// teamId scopes the lookup to the TEAM's deploy run — without
					// it the server would resolve the caller's own dev run.
					const token = await client.getTaskToken({ projectId, source: message.sourceId, teamId });
					if (token) await client.terminate(token);
				});
				break;
			}

			// -- Set / clear a source schedule ------------------------------------
			case 'deployment:setSchedule': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					await client.deploy.setSchedule(projectId, message.sourceId, message.cron, teamId, { ...(message.ttl !== null && message.ttl !== undefined ? { ttl: message.ttl } : {}) });
				});
				break;
			}

			// -- Persist one source's execution settings --------------------------
			case 'deployment:setSourceConfig': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					await client.deploy.setSourceConfig(projectId, message.sourceId, teamId, { ...(message.traceLevel ? { traceLevel: message.traceLevel } : {}), debugOut: message.debugOut });
				});
				break;
			}

			// -- Pause / resume one source's schedule -----------------------------
			case 'deployment:setSchedulePaused': {
				await this.runDeploymentAction(webview, message.requestId, async (client) => {
					if (message.paused) await client.deploy.pauseSchedule(projectId, message.sourceId, teamId);
					else await client.deploy.resumeSchedule(projectId, message.sourceId, teamId);
				});
				break;
			}

			// -- Cron preview (THE single evaluator; no re-fetch needed) ----------
			case 'deployment:preview': {
				try {
					const client = this.requireDeployClient();
					const result = await client.deploy.preview(message.cron, message.count);
					webview.postMessage({ type: 'deployment:previewResult', requestId: message.requestId, result });
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					webview.postMessage({ type: 'deployment:previewResult', requestId: message.requestId, result: {}, error: msg });
				}
				break;
			}

			// -- Validation passthrough (readonly canvas still validates) ---------
			case 'deployment:validate': {
				let result: { errors: unknown[]; warnings: unknown[] } = { errors: [], warnings: [] };
				try {
					const client = this.requireDeployClient();
					result = await client.validate({ pipeline: message.pipeline as Record<string, unknown> });
				} catch {
					// A validation transport failure renders as a clean canvas —
					// same fallback the rocket-ui host uses.
				}
				webview.postMessage({ type: 'deployment:validateResult', requestId: message.requestId, result });
				break;
			}
		}
	}

	/**
	 * Runs one deployment mutation with shared ack handling. The WEBVIEW
	 * drives any refresh afterwards (it owns the focused source and sends
	 * deployment:fetch / deploy:fetch itself) — the host only acks.
	 *
	 * @param webview - The project panel's webview.
	 * @param requestId - Correlation id for the deployment:actionResult ack.
	 * @param action - The deploy API call to run.
	 */
	private async runDeploymentAction(webview: vscode.Webview, requestId: number, action: (client: RocketRideClient) => Promise<void>): Promise<void> {
		try {
			// Step 1: run the mutation against the dev connection's client.
			const client = this.requireDeployClient();
			await action(client);

			// Step 2: ack the drawer's pending promise.
			webview.postMessage({ type: 'deployment:actionResult', requestId });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			webview.postMessage({ type: 'deployment:actionResult', requestId, error: msg });
		}
	}

	/**
	 * The connected SDK client, or throws the standard not-connected error.
	 *
	 * @returns The dev connection's client.
	 */
	private requireDeployClient(): RocketRideClient {
		const client = this.connectionManager.getClient();
		if (!client || !this.connectionManager.isConnected()) throw new Error('Not connected to server');
		return client;
	}

	/**
	 * Fetches the full deployment state and pushes deployment:load (stamped
	 * with the team so a switched drawer drops stale pushes), mirroring the
	 * cloud DeploymentProvider fetchAll: get → artifact → history(teamId) →
	 * versions → preview of the FOCUSED source's schedule → running scan.
	 *
	 * @param webview - The project panel's webview.
	 * @param teamId - The WIRE team id the API calls address ('@me' for the
	 *                 caller's own space).
	 * @param projectId - The deployed project.
	 * @param sourceId - The focused source (the record identity).
	 * @param echoTeamId - The RAW id the webview opened the drawer with
	 *                     (mapTeamDeploymentRows emits `dep.teamId`, e.g.
	 *                     `user~{uid}`); stamped on the pushes so the drawer's
	 *                     stale-record guard matches. Defaults to `teamId`.
	 */
	private async fetchAndPushDeployment(webview: vscode.Webview, teamId: string, projectId: string, sourceId?: string, echoTeamId?: string): Promise<void> {
		// The API calls address the WIRE id, but every push must carry the exact
		// value the webview opened with: a personal deployment opens keyed on the
		// raw 'user~{uid}' row id while the wire id is '@me', so stamping the wire
		// id would make the drawer reject its own load and spin forever.
		const recordTeamId = echoTeamId ?? teamId;
		try {
			const client = this.requireDeployClient();

			// Step 1: the deployment record (version pointer, state, schedules).
			const dep = await client.deploy.get(projectId, teamId);

			// Step 2: the immutable artifact this team runs (readonly DESIGN).
			const pipeline = typeof dep.version === 'number' ? ((await client.deploy.artifact(projectId, dep.version)) as unknown as Record<string, unknown>) : {};

			// Step 3: this team's audit trail + the registry version picker.
			const [history, versions] = await Promise.all([client.deploy.history(projectId, { teamId }), client.deploy.versions(projectId)]);

			// Step 4: next occurrence through THE single evaluator (never parse
			// cron client-side): the FOCUSED source's schedule, or — for the
			// TEAM record — the first armed schedule across every source.
			let nextRun: DeploymentLoadPayload['nextRun'];
			const allScheds = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean }>;
			const sched = sourceId ? allScheds[sourceId] : undefined;
			const armed = sourceId ? (sched?.cron && !sched.paused ? ([sourceId, sched] as const) : undefined) : Object.entries(allScheds).find(([, entry]) => entry.cron && !entry.paused);
			if (armed?.[1].cron && dep.state === 'enabled') {
				const preview = await client.deploy.preview(armed[1].cron, 1);
				const firstAt = preview.valid ? preview.next?.[0] : undefined;
				if (typeof firstAt === 'number') nextRun = { at: firstAt, sourceId: armed[0], cron: armed[1].cron };
			}

			// TEAM record: every armed schedule's next occurrence (the status
			// grid's Next-run column) through the same single evaluator. The
			// previews fan out concurrently — serialized round-trips would
			// stall the drawer by one RTT per scheduled source.
			const nextRuns: Record<string, number> = {};
			if (!sourceId && dep.state === 'enabled') {
				const armedSources = Object.entries(allScheds).filter(([, entry]) => entry.cron && !entry.paused);
				const previews = await Promise.all(
					armedSources.map(async ([sid, entry]) => {
						try {
							const preview = await client.deploy.preview(entry.cron as string, 1);
							return [sid, preview.valid ? preview.next?.[0] : undefined] as const;
						} catch {
							// An unpreviewable cron just leaves the cell empty.
							return [sid, undefined] as const;
						}
					})
				);
				for (const [sid, firstAt] of previews) {
					if (typeof firstAt === 'number') nextRuns[sid] = firstAt;
				}
			}

			// Step 5: which sources have a LIVE run right now — server task
			// registry. A TEAM deployment matches on the descriptor's teamId;
			// a PERSONAL (@me) deployment cannot — its row carries the billing
			// team, never the wire '@me' — so it matches on the trusted owner
			// scope instead (ownerKind/ownerId from rrext_get_tasks), with the
			// uid taken from the record's own 'user~{uid}' key.
			const tasks = (await client.call('rrext_get_tasks')) as {
				tasks?: Array<{
					source?: string;
					teamId?: string;
					runKind?: string;
					ownerKind?: string;
					ownerId?: string;
					pipeline?: { project_id?: string };
				}>;
			};
			const personalUid = recordTeamId.startsWith('user~') ? recordTeamId.slice('user~'.length) : undefined;
			const runningSources: Record<string, boolean> = {};
			for (const t of tasks.tasks ?? []) {
				if (t.pipeline?.project_id !== projectId || !t.source) continue;
				// runKind on BOTH branches: without it a team's ordinary
				// pipeline run on the same project/source would mark the
				// source as deploy-running, exactly as the personal branch
				// already guards against.
				const matches = personalUid
					? t.ownerKind === 'user' && t.ownerId === personalUid && t.runKind === 'deploy'
					: t.teamId === teamId && t.runKind === 'deploy';
				if (matches) runningSources[t.source] = true;
			}

			// Step 6: resolve teams (names + control) and map into view models.
			const teams = resolveDeployTeams(client, [dep]);
			// Focused-source display name from the artifact (id fallback).
			const components = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ id?: string; name?: string }>) : [];
			const sourceName = sourceId ? components.find((c) => c.id === sourceId)?.name || sourceId : undefined;
			const payload: DeploymentLoadPayload = {
				teamName: teamNameOf(teams, teamId),
				deployment: mapDeploymentInfo(dep, projectId),
				pipeline,
				servicesJson: (this.connectionManager.getCachedServices()?.services ?? {}) as Record<string, unknown>,
				...(sourceId ? { sourceId } : {}),
				...(sourceName ? { sourceName } : {}),
				...(sched ? { sourcePaused: sched.paused === true } : {}),
				...(sourceId
					? {
							sourceConfig: {
								traceLevel: ((sched as { traceLevel?: string } | undefined)?.traceLevel ?? null) as 'none' | 'metadata' | 'summary' | 'full' | null,
								debugOut: (sched as { debugOut?: boolean } | undefined)?.debugOut === true,
							},
						}
					: {}),
				schedules: mapScheduleRows(pipeline, dep),
				...(Object.keys(nextRuns).length > 0 ? { nextRuns } : {}),
				versions: mapVersionCards(versions.rows ?? []),
				history: mapHistoryRows(history.rows ?? [], teams, client.getAccountInfo?.()?.userId ?? ''),
				...(nextRun ? { nextRun } : {}),
				runningSources,
				canControl: teams.find((t) => t.id === teamId)?.canControl ?? false,
				isConnected: this.connectionManager.isConnected(),
			};
			webview.postMessage({ type: 'deployment:load', teamId: recordTeamId, ...payload });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// Stamp the addressed record (team + optional source) so the
			// webview can drop errors from a stale fetch after switching.
			webview.postMessage({ type: 'deployment:error', teamId: recordTeamId, ...(sourceId ? { sourceId } : {}), error: msg });
		}
	}

	/**
	 * Fetches this project's deploy lifecycle (registry versions, team
	 * deployments, merged history, team roster) through the deploy API, maps
	 * everything into serialisable view models HOST-side (mirroring
	 * rocket-ui's ProjectProvider deploy closures + useDeployments), and pushes one
	 * deploy:data snapshot to the webview.
	 *
	 * A project that was never published has no registry — the snapshot
	 * degrades to empty arrays rather than an error state, so the DEPLOY
	 * page renders its empty strip.
	 *
	 * @param webview - The editor webview to push the snapshot to.
	 * @param projectId - The editor's project identity (undefined = unsaved).
	 */
	async sendDeployData(webview: vscode.Webview, projectId: string | undefined): Promise<void> {
		const client = this.connectionManager.getClient();

		// No identity or connection yet — the empty snapshot ends the webview's
		// loading state instead of leaving a spinner forever.
		if (!projectId || !client || !this.connectionManager.isConnected()) {
			webview.postMessage({ type: 'deploy:data', versions: [], deployments: [], teams: [] });
			return;
		}

		try {
			// Step 1: fetch the registry + deployments in parallel — versions are
			// project-scoped, list() carries every visible deployment (also the
			// team-roster fallback for rosterless identities).
			const [versions, list] = await Promise.all([client.deploy.versions(projectId), client.deploy.list()]);
			const deploymentRows = list.rows ?? [];

			// Step 2: resolve the caller's teams (names + control rights).
			const teams = resolveDeployTeams(client, deploymentRows);

			// Step 3: map everything into view models and push the snapshot.
			// Where-live rows are RAW facts — the shared ProjectView resolves
			// source names against the pipeline the webview already holds.
			webview.postMessage({
				type: 'deploy:data',
				versions: mapVersionCards(versions.rows ?? []),
				deployments: mapTeamDeploymentRows(deploymentRows, projectId, teams, client.getAccountInfo?.()?.userId ?? ''),
				teams,
			});
		} catch (error) {
			// A project that was never published has no registry — empty strip,
			// but keep the identity-derived team roster so Publish still offers
			// its one-step deploy targets.
			this.logger.error(`[ProjectProvider] Deploy lifecycle fetch failed: ${error}`);
			webview.postMessage({ type: 'deploy:data', versions: [], deployments: [], teams: resolveDeployTeams(client, []) });
		}
	}
}
