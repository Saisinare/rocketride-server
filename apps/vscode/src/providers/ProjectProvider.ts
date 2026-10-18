// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProjectProvider — Unified custom editor for .pipeline files.
 *
 * Combines the former PageEditorProvider (canvas editing, file I/O, undo/redo)
 * and StatusProvider (status, trace, flow monitoring) into a single provider
 * that renders the shared ProjectView component.
 *
 * Uses the ProjectViewIncoming / ProjectViewOutgoing message protocol to
 * communicate with the Project webview.
 */

import * as vscode from 'vscode';
import { readPrefsSnapshot, writePref } from './PrefsBag';
import * as path from 'path';
import { GenericEvent, ConnectionState, PIPE_BUILDER_APP_ID } from '../shared/types';
import type { TaskStatus } from 'shared/tools/pipelines/project/types';
import { ConnectionManager } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConfigManager } from '../config';
import type { PipelineConfig, RocketRideClient } from 'rocketride';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
// Deep import on purpose — see SidebarProvider: the barrel drags view types
// into the extension-host compile; parse.ts is pure.
import { parsePipelineContent } from 'shared/tools/pipelines/parse';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { isDeployRunBody } from '../shared/util/runClassification';
import { handleMissingEnvVars } from '../shared/util/envVarCheck';
import { isCloudConnectionConfigured as hasCloudConnectionConfigured } from '../shared/util/connectionModeAuth';
import { savePipelineDocument } from '../shared/util/pipelineSave';
import type { DeploymentWebviewToHost } from './types/deployTypes';
import type { LogSessionWebviewToHost } from './types/logTypes';
import { DeployLifecycle } from './project/deployLifecycle';
import { openExternalLink } from './project/externalLink';
import type { BusHost } from './toolhost/busHost';

// =============================================================================
// CONSTANTS
// =============================================================================

const PREFS_KEY = 'rocketride.prefs';
const LAYOUTS_KEY = 'rocketride.layouts';
const GLOBAL_PREF_KEYS = new Set(['cloudCanvasPromptDismissed']);
// workspaceState key prefix for the auto-backup of an untitled pipeline's
// content. VS Code does not hot-exit-back-up a custom-editor untitled document,
// so we persist it ourselves (keyed by the untitled URI) and restore it when
// the editor re-resolves empty after a restart. Cleared when the editor closes.
const UNTITLED_BACKUP_PREFIX = 'rocketride.untitledBackup:';

// How long undelivered OAuth tokens are kept for redelivery after a webview
// reload. Long enough to cover a slow consent flow, short enough that stale
// tokens don't linger.
const OAUTH_REDELIVERY_TTL_MS = 5 * 60 * 1000;

// =============================================================================
// TYPES
// =============================================================================

interface EditorState {
	document: vscode.TextDocument;
	webviewPanel: vscode.WebviewPanel;
	projectId?: string;
	isDisposed: boolean;
	isReady: boolean;
	cachedStatuses: Record<string, TaskStatus>;
	/** One-shot: save the document after the next contentChanged, so OAuth tokens reach disk without a manual save. */
	saveAfterOAuthApply?: boolean;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class ProjectProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<vscode.WebviewPanel, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	/** Deployment drawer + run-log DVR transport (project/deployLifecycle.ts). */
	private deployLifecycle = new DeployLifecycle(this.connectionManager);
	private savesForRun: Set<string> = new Set();
	private preferenceUpdateQueue: Promise<void> = Promise.resolve();
	// OAuth tokens that arrived while no live webview existed for their
	// document (e.g. the editor was recycled during the browser round-trip),
	// keyed by document URI. Redelivered after the next view:ready.
	private undeliveredOAuthTokens: Map<string, { tokens: string; state: string; expiresAt: number }> = new Map();

	constructor(
		private readonly context: vscode.ExtensionContext,
		/** The shell bus router — every project editor webview attaches as a
		 *  realm so shell components (checkout, stripe key) ride the bus. The
		 *  project:* postMessage protocol itself migrates in a later pass. */
		private readonly busHost: BusHost
	) {
		this.registerCommands();
		this.setupEventListeners();
		// Drop an untitled pipeline's auto-backup once its editor closes: an
		// explicit save reverts-and-closes it, and a discard just closes it, so
		// only a full VS Code exit leaves the backup behind — which is exactly
		// the case we want to restore on the next launch.
		this.context.subscriptions.push(
			vscode.workspace.onDidCloseTextDocument((closed) => {
				if (closed.isUntitled) {
					void this.context.workspaceState.update(`${UNTITLED_BACKUP_PREFIX}${closed.uri.toString()}`, undefined);
				}
			})
		);
	}

	// =========================================================================
	// SAVE-FOR-RUN CHECK
	// =========================================================================

	public isSaveForRun(uri: vscode.Uri): boolean {
		return this.savesForRun.has(uri.toString());
	}

	public getTaskStatus(projectId: string, sourceId: string): TaskStatus | undefined {
		for (const editorState of this.editorStates.values()) {
			if (editorState.projectId === projectId) {
				return editorState.cachedStatuses[sourceId];
			}
		}
		return undefined;
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	private setupEventListeners(): void {
		const eventListener = this.connectionManager.on('shell:event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Account updates (subscription changes, env changes) are emitted as
		// a dedicated shell:accountUpdate — no longer buried in shell:event
		const accountUpdateListener = this.connectionManager.on('shell:accountUpdate', () => {
			this.broadcastSubscriptionStatus();
		});

		const envKeysChangedListener = this.connectionManager.on('shell:envKeysChanged', () => {
			void this.broadcastEnvKeys();
		});

		const connectionStateListener = this.connectionManager.on('shell:statusChange', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					this.onConnectedClearStaleData();
					// Start monitoring for all open editors that missed initial subscription
					for (const [panel] of this.editorStates) {
						this.startMonitoring(panel).catch((err) => {
							this.logger.error(`Starting monitoring on reconnect: ${err}`);
						});
					}
				}
				this.broadcastConnectionState(this.connectionManager.isConnected());
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		const servicesUpdatedListener = this.connectionManager.on('shell:servicesUpdated', (payload: { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string }) => {
			this.broadcastServicesToAllEditors(payload);
		});

		const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('rocketride.development.connectionMode') || event.affectsConfiguration('rocketride.deployment.connectionMode')) {
				this.broadcastCloudConnectionConfigured();
			}
		});

		this.disposables.push(eventListener, accountUpdateListener, envKeysChangedListener, connectionStateListener, servicesUpdatedListener, configChangeListener);
	}

	// =========================================================================
	// EVENT ROUTING
	// =========================================================================

	private handleEvent(event: GenericEvent): void {
		// Deployment-change invalidations carry their identity as projectId
		// (a server event, not a stamped task body) — relay to the project's
		// editors so the drawer can re-fetch, then stop (nothing below
		// applies to a non-task event).
		if (event.event === 'apaevt_deploy') {
			const deployProject = (event.body as { projectId?: string } | undefined)?.projectId;
			for (const editorState of this.editorStates.values()) {
				if (editorState.isDisposed || !editorState.isReady) continue;
				if (deployProject && editorState.projectId !== deployProject) continue;
				editorState.webviewPanel.webview.postMessage({ type: 'shell:event', event });
			}
			return;
		}

		const projectId = event.body?.project_id;
		if (!projectId) return;

		if (event.event === 'apaevt_status_update') {
			// The status cache feeds the DEV canvas on load — deploy-run
			// statuses (delivered here whenever a team-scoped subscription is
			// open) must not enter it.
			const source = event.body?.source;
			if (source && !isDeployRunBody(event.body)) {
				for (const editorState of this.editorStates.values()) {
					if (!editorState.isDisposed && editorState.projectId === projectId) {
						editorState.cachedStatuses[source] = event.body as TaskStatus;
					}
				}
			}
		}

		// Forward EVERY stamped task event for this project — the server stamps
		// project_id + source into all task-scoped bodies at its forward choke
		// point, so identity is a pure body test. The webview's live log,
		// trace, and run-active timeline consume output/lifecycle events too;
		// a status/flow-only whitelist left them permanently incomplete.
		for (const editorState of this.editorStates.values()) {
			if (editorState.isDisposed || !editorState.isReady) continue;
			if (editorState.projectId !== projectId) continue;
			editorState.webviewPanel.webview.postMessage({ type: 'shell:event', event });
		}
	}

	// =========================================================================
	// BROADCASTING
	// =========================================================================

	private broadcastServicesToAllEditors(payload: { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string }): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview
					.postMessage({
						type: 'project:services',
						services: payload.services,
						icons: payload.icons ?? {},
					})
					.then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post services to webview: ${err}`);
					});
			}
		}
	}

	private broadcastConnectionState(isConnected: boolean): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'shell:connectionChange', isConnected, isSubscribed: subscribed, serverHost: this.connectionManager.getHttpUrl() }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post connectionState to webview: ${err}`);
				});
			}
		}
	}

	private isCloudConnectionConfigured(): boolean {
		return hasCloudConnectionConfigured({
			development: { connectionMode: vscode.workspace.getConfiguration('rocketride.development').get('connectionMode', 'local') },
			deployment: { connectionMode: vscode.workspace.getConfiguration('rocketride.deployment').get('connectionMode', null) },
		});
	}

	private broadcastCloudConnectionConfigured(): void {
		const cloudConnectionConfigured = this.isCloudConnectionConfigured();
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'project:cloudConnectionConfigured', cloudConnectionConfigured }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post cloudConnectionConfigured to webview: ${err}`);
				});
			}
		}
	}

	private getPreferences(): Record<string, unknown> {
		const workspacePrefs = this.context.workspaceState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
		const globalPrefs = this.context.globalState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
		const prefs = { ...workspacePrefs };
		for (const key of GLOBAL_PREF_KEYS) {
			// globalState is authoritative, but a value left in workspaceState by an earlier
			// build is honoured as a fallback so a prior "Don't show again" keeps applying.
			if (Object.prototype.hasOwnProperty.call(globalPrefs, key)) {
				prefs[key] = globalPrefs[key];
			}
		}
		return prefs;
	}

	private broadcastPreferences(prefs: Record<string, unknown>, originatingWebview: vscode.Webview): void {
		for (const editorState of this.editorStates.values()) {
			const webview = editorState.webviewPanel.webview;
			if (editorState.isReady && !editorState.isDisposed && webview && webview !== originatingWebview) {
				webview.postMessage({ type: 'project:initialPrefs', prefs }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post initialPrefs to webview: ${err}`);
				});
			}
		}
	}

	/** Merges preference updates; keys cannot currently be deleted through this path. */
	private updatePreferences(updatedPrefs: Record<string, unknown>, originatingWebview: vscode.Webview): Promise<void> {
		this.preferenceUpdateQueue = this.preferenceUpdateQueue
			.then(async () => {
				const workspacePrefs = this.context.workspaceState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
				const globalPrefs = this.context.globalState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
				// Webviews send one-key patches; ignore a patch that is already stored so
				// every layout drag does not rewrite global storage.
				const workspaceUpdates: Record<string, unknown> = {};
				const globalUpdates: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(updatedPrefs)) {
					const isGlobal = GLOBAL_PREF_KEYS.has(key);
					const current = isGlobal ? globalPrefs[key] : workspacePrefs[key];
					if (current === value) continue;
					if (isGlobal) globalUpdates[key] = value;
					else workspaceUpdates[key] = value;
				}

				// Only touch a scope that actually has updates — most pref writes (layout,
				// navigation mode) are workspace-only and should not rewrite global storage.
				await Promise.all([
					Object.keys(workspaceUpdates).length > 0 ? this.context.workspaceState.update(PREFS_KEY, { ...workspacePrefs, ...workspaceUpdates }) : Promise.resolve(),
					Object.keys(globalUpdates).length > 0 ? this.context.globalState.update(PREFS_KEY, { ...globalPrefs, ...globalUpdates }) : Promise.resolve(),
				]);

				// Broadcast only the global-scoped changes. Workspace prefs (layout,
				// navigation mode) are per-editor view state: propagating them would let one
				// editor's stale full-bag write revert another editor's live UI.
				if (Object.keys(globalUpdates).length > 0) {
					this.broadcastPreferences(globalUpdates, originatingWebview);
				}
			})
			.catch((err: unknown) => {
				this.logger.error(`Failed to persist preferences: ${err}`);
			});
		return this.preferenceUpdateQueue;
	}

	/**
	 * Re-fetches env key names from the server and broadcasts them to all
	 * open editor webviews so the autocomplete list stays in sync after
	 * variables are added or removed on the Environment page.
	 */
	private async broadcastEnvKeys(): Promise<void> {
		const client = this.connectionManager.getClient();
		if (!client) return;

		let envKeys: string[];
		try {
			envKeys = await client.account.getEnvironmentKeys();
		} catch {
			return;
		}

		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'project:envKeysUpdate', envKeys }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post envKeysUpdate to webview: ${err}`);
				});
			}
		}
	}

	/**
	 * Broadcasts updated subscription status to all open editor webviews.
	 * Called when an apaext_account event arrives (subscription change).
	 */
	private broadcastSubscriptionStatus(): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'checkout:subscriptionUpdate', isSubscribed: subscribed }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post subscriptionUpdate to webview: ${err}`);
				});
			}
		}
	}

	// =========================================================================
	// MONITORING
	// =========================================================================

	private async startMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || editorState.isDisposed || !editorState.projectId || !this.connectionManager.isConnected()) {
			return;
		}

		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('No client available');
			// summary/flow feed the canvas + status map; output/task feed the
			// webview's live log and run-active timeline. The webview has no
			// session of its own (the host bridges all events), so the host
			// must subscribe to every class the panes consume. The 'deploy'
			// class rides the global registration: deployment-change
			// invalidations that let the drawer re-fetch instead of polling.
			await client.addMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow', 'output', 'task']);
			// Global classes: 'deploy' = deployment-change invalidations;
			// '*' task = ALL visible runs' lifecycle (the where-live running
			// badges) — each registration also triggers the server's catch-up
			// snapshot, seeding the webview's fold on panel open.
			await client.addMonitor({ token: '*' }, ['deploy', 'task']);
		} catch (error) {
			this.logger.error(`Starting monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private async stopMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || !editorState.projectId) return;

		try {
			const client = this.connectionManager.getClient();
			if (client) {
				await client.removeMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow', 'output', 'task']);
				await client.removeMonitor({ token: '*' }, ['deploy', 'task']);
			}
		} catch (error) {
			this.logger.error(`Stopping monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private onConnectedClearStaleData(): void {
		for (const editorState of this.editorStates.values()) {
			editorState.cachedStatuses = {};
		}
		// Team task monitors are per-connection server-side — a reconnect
		// starts clean, so drop the registration memory and re-register on
		// the next drawer fetch.
		this.deployLifecycle.clearTaskMonitors();
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.openPipelineAsText', (uri: vscode.Uri) => {
				const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
				if (targetUri) {
					vscode.commands.executeCommand('vscode.openWith', targetUri, 'default');
				} else {
					vscode.window.showErrorMessage('No pipeline file selected');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.save', async () => {
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.files.save');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.refresh', async () => {
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			}),
		];

		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	// =========================================================================
	// OAUTH TOKEN DELIVERY
	// =========================================================================

	/**
	 * The live editor state for a document, if any. The custom editor is
	 * registered with supportsMultipleEditorsPerDocument: false, so at most
	 * one live webview exists per document.
	 */
	private findLiveEditorState(docKey: string): EditorState | undefined {
		for (const editorState of this.editorStates.values()) {
			if (!editorState.isDisposed && editorState.isReady && editorState.document.uri.toString() === docKey) {
				return editorState;
			}
		}
		return undefined;
	}

	/**
	 * Deliver broker OAuth tokens to the live webview for the document that
	 * started the login. The webview instance that armed the waiter may have
	 * been disposed during the browser round-trip, so the target is resolved
	 * at delivery time; with no live target the tokens are stashed and
	 * redelivered after the next view:ready.
	 */
	private deliverOAuthTokens(docKey: string, tokens: string, state: string): void {
		const stash = () => {
			this.undeliveredOAuthTokens.set(docKey, { tokens, state, expiresAt: Date.now() + OAUTH_REDELIVERY_TTL_MS });
		};

		const editorState = this.findLiveEditorState(docKey);
		if (!editorState) {
			this.logger.info('[ProjectProvider] OAuth tokens arrived with no live editor; holding for redelivery');
			stash();
			return;
		}

		// Arm the one-shot save before posting: the token apply surfaces as the
		// next project:contentChanged, which must reach disk without Ctrl+S.
		editorState.saveAfterOAuthApply = true;
		editorState.webviewPanel.webview.postMessage({ type: 'project:oauthTokens', tokens, state }).then(
			(posted) => {
				if (!posted) {
					editorState.saveAfterOAuthApply = false;
					stash();
				}
			},
			(err: unknown) => {
				editorState.saveAfterOAuthApply = false;
				stash();
				this.logger.error(`[ProjectProvider] Failed to deliver OAuth tokens: ${err}`);
			}
		);
	}

	// =========================================================================
	// RESOLVE CUSTOM TEXT EDITOR
	// =========================================================================

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const webview = webviewPanel.webview;

		// A hot-exit restored untitled pipeline comes back with empty content
		// (VS Code does not preserve the programmatically-seeded text), which
		// would parse to no project and render a blank canvas. Restore our own
		// auto-backup of the in-progress pipeline if there is one; otherwise
		// seed the empty-pipeline template so the starting-point wizard shows.
		if (document.isUntitled && document.getText().trim() === '') {
			const backup = this.context.workspaceState.get<string>(`${UNTITLED_BACKUP_PREFIX}${document.uri.toString()}`);
			const seedText = backup && backup.trim() !== '' ? backup : JSON.stringify({ components: [] }, null, 2);
			const seed = new vscode.WorkspaceEdit();
			seed.insert(document.uri, new vscode.Position(0, 0), seedText);
			await vscode.workspace.applyEdit(seed);
		}

		const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
		webviewPanel.title = fileName.replace(/\.pipe(\.json)?$/i, '');

		const { projectId } = this.extractPipelineIds(document);

		const editorState: EditorState = {
			document,
			webviewPanel,
			projectId,
			isDisposed: false,
			isReady: false,
			cachedStatuses: {},
		};

		this.editorStates.set(webviewPanel, editorState);

		webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		webview.html = this.getHtmlForWebview(webview);

		// The editor is also a bus realm: shell components inside it (checkout,
		// stripe key) use request('client.*')/host.* ops over the `__rrbus`
		// envelope, which never collides with the typed project:* messages.
		const detachRealm = this.busHost.attachWebview(webview, 'page:project');

		// --- Handle messages from the webview (ProjectViewOutgoing) -----------

		webview.onDidReceiveMessage(async (data) => {
			// Deployment record drawer protocol: the drawer inside THIS webview
			// drives one team deployment; identity = panel project + msg team.
			if (typeof data.type === 'string' && data.type.startsWith('deployment:')) {
				try {
					await this.deployLifecycle.handleDeploymentMessage(webview, editorState.projectId ?? '', data as DeploymentWebviewToHost);
				} catch (error) {
					this.logger.error(`[ProjectProvider] Deployment message error: ${error}`);
				}
				return;
			}
			// Run-log session protocol (the DVR bridge): proxy session calls
			// onto real client.log streams; play items push back as events.
			if (typeof data.type === 'string' && data.type.startsWith('logsession:')) {
				try {
					await this.deployLifecycle.handleLogSessionMessage(webview, editorState.projectId ?? '', data as LogSessionWebviewToHost);
				} catch (error) {
					this.logger.error(`[ProjectProvider] Log session message error: ${error}`);
				}
				return;
			}
			switch (data.type) {
				case 'view:ready': {
					editorState.isReady = true;

					// Seed the realm's prefs store FIRST (grid layouts answer
					// synchronously from it — see useGridConfigAnswering).
					void editorState.webviewPanel.webview.postMessage({ type: 'prefs:init', values: readPrefsSnapshot(this.context) });

					// Build project from document
					const text = document.getText();
					const parsed = parsePipelineContent(text, document.uri.fsPath);
					let project: Record<string, unknown> | undefined;
					if (parsed.isValid) {
						try {
							project = JSON.parse(this.enrichComponentNames(text));
						} catch {
							/* invalid JSON */
						}
					}

					// Load layout defaults + prefs
					const layouts = this.context.workspaceState.get<Record<string, Record<string, unknown>>>(LAYOUTS_KEY) ?? {};
					const layout = layouts[document.uri.toString()] ?? {};
					const storedPrefs = this.getPreferences();
					const cached = this.connectionManager.getCachedServices();
					const client = this.connectionManager.getClient();
					let envKeys: string[] | undefined;
					try {
						envKeys = await client?.account?.getEnvironmentKeys();
					} catch {
						envKeys = undefined;
					}

					// Send everything in one message
					webview.postMessage({
						type: 'project:load',
						project,
						viewState: { mode: 'design', ...layout },
						prefs: storedPrefs,
						services: cached.services,
						icons: cached.icons,
						isConnected: this.connectionManager.isConnected(),
						isSubscribed: isSubscribed(client, PIPE_BUILDER_APP_ID),
						cloudConnectionConfigured: this.isCloudConnectionConfigured(),
						statuses: editorState.cachedStatuses,
						serverHost: this.connectionManager.getHttpUrl(),
						// The OAuth broker only allows https://*.rocketride.ai redirect URLs,
						// so tokens bounce off the CLOUD SERVER's hosted page, which forwards
						// them to the `<uriScheme>://rocketride.rocketride/auth/google` deep
						// link. The bounce host is the effective cloud target (a setting,
						// never a bake) — a custom server hosts its own bounce endpoint.
						oauthReturnUrl: `${ConfigManager.getInstance().getEffectiveCloudUrl()}/auth/vscode/google?scheme=${vscode.env.uriScheme}`,
						envKeys,
					});
					webview.postMessage({ type: 'project:dirtyState', isDirty: document.isDirty, isNew: document.isUntitled });

					// Redeliver OAuth tokens that arrived while this document had no
					// live webview. Safe ordering: the webview clears its pending
					// tokens in the project:load handler above, so this arrives after.
					const oauthKey = document.uri.toString();
					const undelivered = this.undeliveredOAuthTokens.get(oauthKey);
					if (undelivered) {
						this.undeliveredOAuthTokens.delete(oauthKey);
						if (undelivered.expiresAt > Date.now()) {
							this.deliverOAuthTokens(oauthKey, undelivered.tokens, undelivered.state);
						}
					}

					// Kick off background services refresh
					this.connectionManager.refreshServices().catch((err) => {
						this.logger.error(`Background services refresh failed: ${err}`);
					});

					// Start monitoring
					try {
						await this.startMonitoring(webviewPanel);
					} catch (error) {
						this.logger.error(`Starting monitoring after webview ready: ${error}`);
					}
					break;
				}

				// Canvas messages
				case 'project:contentChanged': {
					if (data.project) {
						const content = typeof data.project === 'string' ? data.project : JSON.stringify(data.project);
						const { applied } = await this.applyDocumentEdit(document, content);
						// Auto-backup untitled pipelines so in-progress work survives
						// a VS Code restart (hot exit does not preserve custom-editor
						// untitled documents). Cleared when the editor closes.
						if (document.isUntitled) {
							void this.context.workspaceState.update(`${UNTITLED_BACKUP_PREFIX}${document.uri.toString()}`, document.getText());
						}
						// One-shot save after an OAuth token apply: tokens must reach
						// the .pipe on disk without requiring a manual save.
						if (editorState.saveAfterOAuthApply) {
							editorState.saveAfterOAuthApply = false;
							if (applied || document.isDirty) {
								await document.save();
							}
						}
					}
					break;
				}

				case 'project:validate': {
					this.logger.output(`${icons.pipeline} Validating pipeline...`);
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const result = await client.validate({ pipeline: data.pipeline });
						this.logger.output(`${icons.success} Pipeline validation passed`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.output(`${icons.error} Pipeline validation failed: ${msg}`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result: { errors: [], warnings: [] }, error: msg });
					}
					break;
				}

				case 'project:getNodeSchema': {
					// The bulk services payload is summary-only; the canvas requests
					// one provider's FULL definition (config schema) on demand and
					// caches it webview-side, so this fires once per provider.
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const service = await client.getService(data.provider);
						webview.postMessage({ type: 'project:nodeSchemaResponse', requestId: data.requestId, service });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`Fetching service definition for '${data.provider}': ${msg}`);
						webview.postMessage({ type: 'project:nodeSchemaResponse', requestId: data.requestId, error: msg });
					}
					break;
				}

				case 'project:requestSave': {
					// Same save flow as the Ctrl+S keybinding: in place for
					// titled files, the native OS Save dialog (defaulted into the
					// pipelines directory, .pipe filter) for untitled ones.
					// Reveal first so the revert-and-close inside the untitled
					// branch targets this editor.
					try {
						webviewPanel.reveal(undefined, false);
						await savePipelineDocument(document);
					} catch (error) {
						vscode.window.showErrorMessage(`Failed to save pipeline: ${error instanceof Error ? error.message : String(error)}`);
					}
					break;
				}

				case 'project:openCloudSetup': {
					// Focus the Development tab only. The prompt must not stage a connection-mode
					// change the user never typed: `development.connectionMode` is workspace-global,
					// and a later Save would tear down their running dev engine.
					await vscode.commands.executeCommand('rocketride.page.settings.open', 'development');
					break;
				}

				// Status messages
				case 'status:pipelineAction': {
					const action = data.action as 'run' | 'stop' | 'restart';
					const source = data.source as string | undefined;
					if (action === 'run' || action === 'restart') {
						// Gate: check connection before running
						const runClient = this.connectionManager.getClient();
						if (!runClient) {
							vscode.window.showErrorMessage('Not connected to server');
							break;
						}
						// Gate: check subscription before running
						const sub = isSubscribed(runClient, PIPE_BUILDER_APP_ID);
						if (!sub) {
							webview.postMessage({ type: 'checkout:required' });
							break;
						}
						const uriKey = document.uri.toString();
						let savedKey: string | undefined;
						this.savesForRun.add(uriKey);
						try {
							// Capture the text up front: the untitled save flow below
							// closes the buffer, after which the document is disposed.
							const text = document.getText();
							let runTarget: vscode.Uri | undefined = document.uri;
							if (document.isUntitled) {
								// saveDocument() cannot name an untitled buffer (identical
								// content is a no-op), which would let the pipeline run
								// nameless and unsaved. Drive the full untitled save flow
								// (OS Save dialog) and run ONLY once it succeeded — a
								// cancelled dialog cancels the run. Reveal first so the
								// revert-and-close inside targets this editor (same rule
								// as project:requestSave).
								webviewPanel.reveal(undefined, false);
								runTarget = await savePipelineDocument(document);
							} else {
								await this.saveDocument(document, text);
							}
							if (runTarget) {
								// The untitled save reopens the file under a NEW URI —
								// the save-for-run suppression must follow it, or the
								// saved document's own change events escape the guard.
								savedKey = runTarget.toString();
								this.savesForRun.add(savedKey);
								const parsed = JSON.parse(text);
								const pipeName = path.basename(runTarget.fsPath, '.pipe');
								await this.runPipeline({ pipeline: { ...parsed, source: source ?? parsed.source } }, pipeName);
							}
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : String(error);
							vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
						}
						setTimeout(() => {
							this.savesForRun.delete(uriKey);
							if (savedKey) this.savesForRun.delete(savedKey);
						}, 2000);
					} else if (action === 'stop') {
						if (source) {
							await this.stopPipeline(source, document);
						}
					}
					break;
				}

				// Missing env vars — webview detected ROCKETRIDE_* refs not in envKeys
				case 'status:missingEnvVars': {
					const keys = data.keys as string[];
					if (keys?.length) {
						await handleMissingEnvVars(keys);
					}
					break;
				}

				// Link opening
				case 'project:openLink': {
					if (data.url) {
						openExternalLink(data.url as string, data.displayName as string | undefined, data.browser as boolean | undefined);
					}
					break;
				}

				// OAuth login: open the broker URL in the system browser (Google's
				// consent screen refuses to render in a webview iframe) and arm a
				// one-shot callback so the deep-link return delivers tokens back to
				// this panel via project:oauthTokens.
				case 'project:openExternal': {
					if (data.url) {
						// Webview-supplied URL: require a parseable https target
						// before arming any OAuth state (same spirit as openLink's
						// scheme allowlist; OAuth brokers are https-only).
						let parsedUrl: URL;
						try {
							parsedUrl = new URL(data.url as string);
						} catch {
							this.logger.error('[ProjectProvider] Blocked unparseable OAuth URL');
							break;
						}
						if (parsedUrl.protocol !== 'https:') {
							this.logger.error(`[ProjectProvider] Blocked OAuth URL scheme: ${parsedUrl.protocol}`);
							// A silent break here turns a misconfigured broker URL
							// (e.g. an http:// dev override baked into the webview)
							// into a dead button with no feedback — say so instead.
							vscode.window.showErrorMessage(`Sign-in blocked: the OAuth broker URL must use https (got "${parsedUrl.protocol}//"). Rebuild the extension without a non-https REACT_APP_OAUTH_ROOT_URL override.`);
							break;
						}
						// Key the waiter by the node that started the login so the
						// deep-link return routes to the right editor. The callback
						// resolves the live webview at delivery time — this webview
						// instance may be disposed during the browser round-trip.
						const nodeId = parsedUrl.searchParams.get('node_id') || (data.url as string);
						const docKey = document.uri.toString();
						const unregister = CloudAuthProvider.getInstance().setPendingGoogleOAuth(nodeId, (tokens, state) => {
							this.deliverOAuthTokens(docKey, tokens, state);
						});
						// Pass the raw string: Uri.parse re-encodes the query and un-escapes
						// %3B/%3A, and Zitadel's Go parser rejects raw semicolons in queries
						// (microsoft/vscode#85930). openExternal accepts a string at runtime.
						try {
							const opened = await vscode.env.openExternal(data.url as unknown as vscode.Uri);
							if (!opened) throw new Error('the system browser refused to open');
						} catch (error) {
							// A dead waiter would swallow a later unrelated deep link.
							unregister();
							this.logger.error(`[ProjectProvider] Failed to open OAuth URL: ${error}`);
							vscode.window.showErrorMessage('Could not open the browser for sign-in. Check your default browser and try again.');
						}
					}
					break;
				}

				// View state change — not persisted in VS Code
				case 'prefs:set':
					writePref(this.context, data.key, data.value, data.scope);
					break;

				case 'project:viewStateChange': {
					// Update layouts (per-document defaults for future opens)
					if (data.viewState) {
						const allLayouts = this.context.workspaceState.get<Record<string, unknown>>(LAYOUTS_KEY) ?? {};
						allLayouts[document.uri.toString()] = data.viewState;
						this.context.workspaceState.update(LAYOUTS_KEY, allLayouts).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist layout: ${err}`);
						});
					}
					break;
				}

				// Prefs change — dismissal is global; other preferences remain workspace-scoped.
				case 'project:prefsChange': {
					if (typeof data.prefs === 'object' && data.prefs !== null && !Array.isArray(data.prefs)) {
						await this.updatePreferences(data.prefs, webview);
					}
					break;
				}

				// Checkout rides the bus (client.billing.* ops + host.stripeKey)
				// — no checkout:* request handling here. checkout:required and
				// checkout:subscriptionUpdate remain host-originated pushes.

				// Deploy lifecycle — snapshot request from the DEPLOY page
				case 'deploy:fetch': {
					await this.deployLifecycle.sendDeployData(webview, editorState.projectId);
					break;
				}

				// Deploy lifecycle — one immutable artifact for the version drawer
				case 'deploy:artifact': {
					try {
						const deployClient = this.connectionManager.getClient();
						if (!deployClient) throw new Error('Not connected to server');
						const pipeline = await deployClient.deploy.artifact((data.projectId as string) || editorState.projectId || '', data.version as number);
						webview.postMessage({ type: 'deploy:artifactResult', requestId: data.requestId, pipeline });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`[ProjectProvider] Artifact fetch failed: ${msg}`);
						webview.postMessage({ type: 'deploy:artifactResult', requestId: data.requestId, error: msg });
					}
					break;
				}

				// Deploy lifecycle — publish the SAVED document as the next version
				case 'deploy:publish': {
					try {
						const deployClient = this.connectionManager.getClient();
						if (!deployClient) throw new Error('Not connected to server');
						// Publish snapshots the DOCUMENT, never webview state: the
						// immutable registry must hold exactly what is on disk, so a
						// dirty or never-saved document blocks the publish outright.
						if (document.isUntitled) throw new Error('Save the pipeline first');
						// Save-first: a dirty document is saved before the snapshot,
						// so the registry still holds exactly what is on disk.
						if (document.isDirty) {
							const saved = await document.save();
							if (!saved) throw new Error('Save failed; publish cancelled');
						}
						const parsed = JSON.parse(document.getText()) as PipelineConfig;
						// The registry renders pipelineName on every deploy surface;
						// .pipe JSON rarely carries one (names live in FILENAMES), so
						// the snapshot takes the file's basename when the JSON has
						// none — building the publish() signature's required name.
						const pipeline = {
							...parsed,
							name:
								parsed.name ||
								document.uri.path
									.split('/')
									.pop()
									?.replace(/\.pipe(?:\.json)?$/, '') ||
								document.uri.path,
						};
						await deployClient.deploy.add({ pipeline, ...(data.comment ? { comment: data.comment as string } : {}), ...(data.deployTo ? { deployTo: data.deployTo as string } : {}) });
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId });
						// Re-push the lifecycle so the strip/history show the new truth.
						await this.deployLifecycle.sendDeployData(webview, editorState.projectId);
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`[ProjectProvider] Publish failed: ${msg}`);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId, error: msg });
					}
					break;
				}

				// Deploy lifecycle — point a team at a version (promotion/rollback)
				case 'deploy:deploy': {
					try {
						const deployClient = this.connectionManager.getClient();
						if (!deployClient) throw new Error('Not connected to server');
						await deployClient.deploy.deploy((data.projectId as string) || editorState.projectId || '', data.version as number, data.teamId as string);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId });
						// Re-push the lifecycle so badges/where-live show the new truth.
						await this.deployLifecycle.sendDeployData(webview, editorState.projectId);
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`[ProjectProvider] Deploy failed: ${msg}`);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId, error: msg });
					}
					break;
				}
			}
		});

		// Listen for document changes (undo/redo) and sync to webview
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				const { projectId: newProjectId } = this.extractPipelineIds(e.document);
				editorState.projectId = newProjectId;
				this.sendCanvasUpdate(webview, e.document);
				if (editorState.isReady) {
					webview.postMessage({ type: 'project:dirtyState', isDirty: e.document.isDirty, isNew: e.document.isUntitled });
				}
			}
		});

		// Listen for saves to clear dirty state in canvas
		const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
			if (savedDoc.uri.toString() === document.uri.toString() && editorState.isReady) {
				webview.postMessage({ type: 'project:dirtyState', isDirty: false, isNew: savedDoc.isUntitled });
			}
		});

		// Clean up when panel is disposed
		webviewPanel.onDidDispose(async () => {
			detachRealm();
			await this.stopMonitoring(webviewPanel);
			// Close any run-log sessions the DVR bridge left open.
			this.deployLifecycle.disposeLogSessions(webview);
			editorState.cachedStatuses = {};
			editorState.isDisposed = true;
			this.editorStates.delete(webviewPanel);
			changeDocumentSubscription.dispose();
			saveDocumentSubscription.dispose();
		});

		// Start monitoring immediately if connected
		if (this.connectionManager.isConnected()) {
			this.startMonitoring(webviewPanel).catch((error) => {
				this.logger.error(`Starting initial monitoring: ${error}`);
			});
		}
	}

	// =========================================================================
	// DOCUMENT I/O
	// =========================================================================

	private sendCanvasUpdate(webview: vscode.Webview, document: vscode.TextDocument): void {
		const text = document.getText();
		const parsed = parsePipelineContent(text, document.uri.fsPath);
		if (!parsed.isValid) {
			return;
		}

		const enriched = this.enrichComponentNames(text);
		try {
			const project = JSON.parse(enriched);
			webview.postMessage({ type: 'project:update', project });
		} catch {
			// Invalid JSON — skip
		}
	}

	private enrichComponentNames(text: string): string {
		const cached = this.connectionManager.getCachedServices();
		const services = cached?.services;
		if (!services || Object.keys(services).length === 0) return text;

		const pipeline = JSON.parse(text);
		const components = pipeline.components as Array<{ provider: string; name?: string }> | undefined;
		if (!components) return text;

		let changed = false;
		for (const component of components) {
			if (!component.name) {
				const service = services[component.provider] as { title?: string } | undefined;
				if (service?.title) {
					component.name = service.title;
					changed = true;
				}
			}
		}

		return changed ? JSON.stringify(pipeline, null, 2) : text;
	}

	private toVerboseJson(content: string | Record<string, unknown>): string {
		const obj = typeof content === 'string' ? JSON.parse(content) : content;
		return JSON.stringify(obj, null, 2);
	}

	private async applyDocumentEdit(document: vscode.TextDocument, content: string): Promise<{ changed: boolean; applied: boolean }> {
		let normalizedNew: string;
		try {
			normalizedNew = this.toVerboseJson(content);
		} catch {
			normalizedNew = content;
		}
		const currentText = document.getText();
		let normalizedCurrent: string;
		try {
			normalizedCurrent = this.toVerboseJson(currentText);
		} catch {
			normalizedCurrent = currentText;
		}
		if (normalizedNew === normalizedCurrent) {
			return { changed: false, applied: false };
		}

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentText.length));
		edit.replace(document.uri, fullRange, normalizedNew);
		const success = await vscode.workspace.applyEdit(edit);
		if (!success) {
			this.logger.error('[ProjectProvider] Failed to apply document edit');
		}
		return { changed: true, applied: success };
	}

	private async saveDocument(document: vscode.TextDocument, content: string | Record<string, unknown>): Promise<void> {
		const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
		const { changed, applied } = await this.applyDocumentEdit(document, contentStr);
		if (applied) {
			await document.save();
		} else if (changed) {
			vscode.window.showErrorMessage('Failed to save pipeline file');
		}
	}

	private extractPipelineIds(document: vscode.TextDocument): { projectId?: string; sourceId?: string } {
		try {
			const content = document.getText();
			const parsed = JSON.parse(content);
			return { projectId: parsed.project_id, sourceId: parsed.source };
		} catch {
			return { projectId: undefined, sourceId: undefined };
		}
	}

	// =========================================================================
	// PIPELINE EXECUTION
	// =========================================================================

	private async runPipeline(document: { pipeline: PipelineConfig }, name?: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const project = document.pipeline;

			// TTL, trace level, task arguments, and debug output are workspace
			// settings; the host reads them here and passes them per task to the
			// engine. There is no per-pipeline override.
			const cfg = ConfigManager.getInstance().getConfig();

			await client.use({
				pipeline: project,
				source: project.source,
				pipelineTraceLevel: cfg.pipelineTraceLevel,
				args: ConfigManager.getInstance().getTaskArgs(),
				name,
				// ttl comes straight from settings (0 = no timeout).
				...(cfg.pipelineTtl !== undefined ? { ttl: cfg.pipelineTtl } : {}),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
		}
	}

	private async stopPipeline(componentId: string, document: vscode.TextDocument): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const parsed = JSON.parse(document.getText());
			const projectId = parsed.project_id;

			if (!projectId || !componentId) {
				this.logger.error(`[ProjectProvider] Missing projectId or componentId`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			const token = await client.getTaskToken({ projectId, source: componentId });

			if (!token) {
				this.logger.error('[ProjectProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			await client.terminate(token);
		} catch (error: unknown) {
			this.logger.error(`[ProjectProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-project.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Inject CSP meta tag allowing Stripe Elements (js.stripe.com for scripts/frames,
			// api.stripe.com for network calls). Required for the in-editor checkout flow.
			const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://js.stripe.com; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} data:; frame-src https://js.stripe.com; connect-src ${webview.cspSource} https://api.stripe.com; img-src ${webview.cspSource} data:;">`;
			htmlContent = htmlContent.replace('<head>', `<head>\n\t${cspMeta}`);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			this.logger.error(`Error loading project editor HTML: ${error}`);
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Project Editor</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
		}
	}

	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
