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


	constructor(private readonly connectionManager: ConnectionManager) {}



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
	 * The connected SDK client, or throws the standard not-connected error.
	 *
	 * @returns The dev connection's client.
	 */
	private requireDeployClient(): RocketRideClient {
		const client = this.connectionManager.getClient();
		if (!client || !this.connectionManager.isConnected()) throw new Error('Not connected to server');
		return client;
	}


}
