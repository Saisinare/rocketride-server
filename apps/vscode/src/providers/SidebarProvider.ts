// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarProvider — Extension host provider for the tool-registry sidebar.
 *
 * The host side of the sidebar webview: resolves the view, routes its
 * messages, persists the strip state (mode, tab order, disabled builtins)
 * in the prefs bag, pushes connection/auth updates from both managers
 * (ConnectionManager dev, DeployManager deploy), and serves the generic
 * tool-host capabilities (workspace FS, the devtool peer relay).
 *
 * The meatier concerns live in sibling modules:
 *   - sidebar/toolRows.ts      — pinned tool rows + catalog (icons inlined)
 *   - sidebar/pipelineFiles.ts — .pipe stamping invariant, restart-on-save,
 *                                and the open/run/stop actions
 *
 * The webview (views/sidebar/SidebarWebview.tsx) renders SidebarChrome over
 * the builtin-tool registry; its controllers discover pipelines and apps
 * themselves over the workspace-FS service.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../config';
import { ConnectionManager, isCloudConnected } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { GenericEvent, PIPE_BUILDER_APP_ID } from '../shared/types';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { isDeployRunBody } from '../shared/util/runClassification';
import { getLogger } from '../shared/util/output';
import { getPipelineProvider } from '../extension';
import { DevToolStore } from './DevToolStore';
import type { BusHost } from './toolhost/busHost';
import { readPref, readPrefsSnapshot, writePref } from './PrefsBag';
import { WorkspaceFsService } from './toolhost/workspaceFsService';
import { ToolRows } from './sidebar/toolRows';
import type { ToolRowDTO } from './sidebar/toolRows';
import { PipelineFiles } from './sidebar/pipelineFiles';

/** workspaceState key for the persisted sidebar mode. */
const SIDEBAR_MODE_KEY = 'sidebarMode';

/** workspaceState key for the persisted strip tab order. */
const TAB_ORDER_KEY = 'sidebarTabOrder';
/** workspaceState key: builtin tools the user has DISABLED (default: none). */
const DISABLED_BUILTINS_KEY = 'disabledBuiltins';

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();
	private deployManager = DeployManager.getDeployInstance();

	// ── Sidebar mode (persisted per workspace) ───────────────────────────────
	// NO App Builder state here: MY APPS discovery runs in the WEBVIEW's
	// AppDev controller (shared tools/appdev) over the generic workspace-FS
	// service — the extension host no longer knows what an .rrapp binding is.
	private sidebarMode: string = 'apps';

	/** Persisted strip tab order (mode ids + `tool:<appId>` ids). */
	private tabOrder: string[] = [];

	/** Persisted set of DISABLED builtin tools (enable/disable, no uninstall). */
	private disabledBuiltins: string[] = [];

	private logger = getLogger();

	/** Generic workspace-FS capability for the webview's tool controllers. */
	private workspaceFs = new WorkspaceFsService();

	/** Pinned tool rows + the dev-tool catalog (icons inlined). */
	private toolRows: ToolRows;

	/** The host's .pipe concerns: stamping, restart-on-save, open/run/stop. */
	private pipelineFiles: PipelineFiles;

	/** The engine origin baked into the current webview HTML's CSP. */
	private htmlEngineOrigin = '';

	/** Detaches this webview's bus-realm attachment (fresh per resolve). */
	private detachBusRealm?: () => void;

	/**
	 * Creates the sidebar provider.
	 * Sets up file watchers and event listeners.
	 *
	 * @param extensionUri - The extension root for webview resources.
	 * @param context - Extension context; persists the sidebar mode across reloads.
	 * @param devTools - The pinned dev-tools store feeding the tool tabs.
	 * @param busHost - The shell bus root (this webview attaches as a spoke;
	 *   tool peer traffic rides its retained/signal lanes).
	 */
	constructor(private readonly extensionUri: vscode.Uri, private readonly context?: vscode.ExtensionContext, private readonly devTools?: DevToolStore, private readonly busHost?: BusHost) {
		// Restore the last mode (previously session-only — it died on reload)
		// and the persisted strip order.
		// DELIBERATE per-host default: 'apps' in VS Code, 'agent' on web. A
		// persisted mode whose tool is disabled falls back in SidebarChrome.
		this.sidebarMode = (this.context ? readPref<string>(this.context, SIDEBAR_MODE_KEY) : undefined) ?? 'apps';
		this.tabOrder = (this.context ? readPref<string[]>(this.context, TAB_ORDER_KEY) : undefined) ?? [];
		this.disabledBuiltins = (this.context ? readPref<string[]>(this.context, DISABLED_BUILTINS_KEY) : undefined) ?? [];
		this.toolRows = new ToolRows(this.connectionManager, this.devTools, this.context);
		this.pipelineFiles = new PipelineFiles(this.connectionManager, this.configManager);
		this.disposables.push(...this.pipelineFiles.setupFileWatching());
		this.setupEventListeners();
		this.disposables.push({ dispose: () => this.workspaceFs.dispose() });
		// Pin/unpin from anywhere (the picker, the tool panel's Remove row)
		// refreshes the tabs.
		if (this.devTools) {
			const sub = this.devTools.onDidChange(() => this.pushToolsUpdate());
			this.disposables.push(sub);
		}
	}

	// =========================================================================
	// WEBVIEW LIFECYCLE
	// =========================================================================

	/** Called by VS Code when the sidebar view becomes visible for the first time. */
	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._view = webviewView;

		// Shell bus spoke: a re-resolved webview is a FRESH realm — detach
		// the previous attachment (rejects its in-flight requests, clears
		// its registrations) before attaching the new one.
		this.detachBusRealm?.();
		this.detachBusRealm = this.busHost?.attachWebview(webviewView.webview, 'sidebar');

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const html = this.getHtmlForWebview(webviewView.webview);
		webviewView.webview.html = html;

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				// Generic tool-host capability services (workspace FS for the
				// tool controllers running in this webview) — routed before
				// the UI messages; the host stays ignorant of what the
				// controllers are scanning for.
				if (this.workspaceFs.handle(message, (m) => void this._view?.webview.postMessage(m))) return;

				switch (message.type) {
					case 'view:ready':
						// A fresh page restarts its service-subscription ids —
						// drop the previous page's watchers before anything else.
						this.workspaceFs.resetSubscriptions();
						// Seed the mode strip FIRST (synchronous, from persisted
						// state alone) so its first paint already has the final
						// tab set and order — the full update below is slow
						// (icon fetches, dashboard) and must not be what shapes
						// the strip.
						this.sendStripSeed();
						this.sendFullUpdate();
						// Replay the fronted tool document — a fresh webview
						// must not boot with every tool sidebar unselected
						// while a tool tab is in front.
						void this._view?.webview.postMessage({ type: 'devtool:activeDoc', ...this.activeToolDoc });
						break;
					case 'sidebar:command':
						vscode.commands.executeCommand(message.command, ...(message.args ?? []));
						break;
					case 'sidebar:openFile':
						void this.pipelineFiles.openPipelineFile(message.fsPath);
						break;
					case 'sidebar:runPipeline':
						void this.pipelineFiles.runPipeline(message.fsPath, message.sourceId);
						break;
					case 'sidebar:stopPipeline':
						void this.pipelineFiles.stopPipeline(message.projectId, message.sourceId);
						break;
					case 'sidebar:openUnknownTask':
						vscode.commands.executeCommand('rocketride.page.status.open', message.projectId, message.sourceId, message.displayName);
						break;
					case 'sidebar:openApp':
						vscode.commands.executeCommand('rocketride.app.open', message.appId);
						break;
					case 'sidebar:setSidebarMode':
						// Persisted per workspace and included in every full update
						// so a reloaded webview restores the user's last mode.
						this.sidebarMode = message.mode;
						if (this.context) void writePref(this.context, SIDEBAR_MODE_KEY, message.mode, 'workspace');
						break;
					case 'sidebar:openTool':
						vscode.commands.executeCommand('rocketride.devtool.open', message.toolId);
						break;
					case 'sidebar:focusTool':
						// Strip tab selection: bring an open window of the tool
						// forward; never create one for a mere tab switch.
						vscode.commands.executeCommand('rocketride.devtool.reveal', message.toolId);
						break;
					case 'sidebar:refreshTools':
						// The Dev Tools panel's RESET — see refreshDevTools.
						void this.refreshDevTools();
						break;
					case 'sidebar:removeTool':
						this.devTools?.remove(message.toolId);
						break;
					case 'sidebar:setDisabledBuiltins':
						// Builtins are enabled/disabled, never uninstalled —
						// persisted per workspace like the tab order.
						this.disabledBuiltins = message.ids;
						if (this.context) void writePref(this.context, DISABLED_BUILTINS_KEY, message.ids, 'workspace');
						break;
					case 'sidebar:reorderTabs':
						// Full strip order (modes + tools) — persisted per
						// workspace; the webview already reordered optimistically.
						this.tabOrder = message.order;
						if (this.context) void writePref(this.context, TAB_ORDER_KEY, message.order, 'workspace');
						break;
					case 'sidebar:showToolReadme':
						vscode.commands.executeCommand('rocketride.devtool.readme', message.toolId);
						break;
					case 'prefs:set':
						// Persists one prefs-store write (fire-and-forget).
						if (this.context) writePref(this.context, message.key, message.value, message.scope);
						break;
					case 'sidebar:openToolDocument':
						// A tool's sidebar mount opens one of ITS documents (the
						// DevToolProps.documents API) — e.g. a connection's tab.
						vscode.commands.executeCommand('rocketride.devtool.open', message.appId, message.docKey, message.title);
						break;
					case 'sidebar:closeToolDocument':
						vscode.commands.executeCommand('rocketride.devtool.close', message.appId, message.docKey);
						break;
				}
			} catch (error) {
				this.logger.error(`Sidebar message '${String((message as { type?: string })?.type)}' failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		webviewView.onDidDispose(() => {
			this.detachBusRealm?.();
			this.detachBusRealm = undefined;
			this._view = undefined;
		});
	}

	// =========================================================================
	// STRIP STATE
	// =========================================================================

	/**
	 * Posts the synchronous strip bootstrap: pinned tool rows from the
	 * last-known cache, the persisted tab order, and the persisted mode. Sent
	 * on `view:ready` BEFORE the full update, so the strip's first paint
	 * already has its final tab set and order — late-resolving fresh rows
	 * replace the cached ones in place instead of reshuffling the strip.
	 */
	private sendStripSeed(): void {
		void this._view?.webview.postMessage({ type: 'sidebar:stripSeed', tools: this.toolRows.cachedRows(), tabOrder: this.tabOrder, sidebarMode: this.sidebarMode, disabledBuiltins: this.disabledBuiltins });
		this.sendPrefsInit();
	}

	/**
	 * Seeds the webview's prefs store from the shared PrefsBag. Sent once
	 * per view:ready, BEFORE any tool mounts, so synchronous reads never
	 * observe a pre-hydration snapshot.
	 */
	private sendPrefsInit(): void {
		if (!this.context) return;
		void this._view?.webview.postMessage({ type: 'prefs:init', values: readPrefsSnapshot(this.context) });
	}

	/**
	 * Sets the sidebar mode FROM THE HOST (a tool panel gained focus) —
	 * persists it and pushes a dedicated mode update (the full-update path
	 * deliberately seeds the webview's mode only once).
	 *
	 * @param mode - The mode to select (e.g. `tool:<appId>`).
	 */
	public setModeExternal(mode: string): void {
		this.sidebarMode = mode;
		if (this.context) void writePref(this.context, SIDEBAR_MODE_KEY, mode, 'workspace');
		// Reveal the RocketRide sidebar (keeping keyboard focus where it is)
		// so the tool's sidebar body is actually on screen, then switch its
		// strip to the tool's tab.
		this._view?.show?.(true);
		void this._view?.webview.postMessage({ type: 'sidebar:modeUpdate', mode });
	}

	/** The fronted tool document (replayed to a freshly booted webview). */
	private activeToolDoc: { appId: string | null; docKey: string | null } = { appId: null, docKey: null };

	/**
	 * Relays the editor's fronted tool document to the sidebar webview — the
	 * tool sidebar mounts follow it (highlight the fronted document, clear on
	 * null).
	 *
	 * @param appId - The fronted tool's app id, or null for a non-tool tab.
	 * @param docKey - The fronted tool document's key, or null.
	 */
	public notifyToolActiveDoc(appId: string | null, docKey: string | null): void {
		this.activeToolDoc = { appId, docKey };
		void this._view?.webview.postMessage({ type: 'devtool:activeDoc', appId, docKey });
	}

	/** Pushes the fresh tool rows + catalog to the webview (pin/unpin, account change). */
	private pushToolsUpdate(): void {
		void Promise.all([this.toolRows.buildToolRows(), this.toolRows.buildAvailableTools()]).then(([tools, available]) => {
			this._view?.webview.postMessage({ type: 'sidebar:toolsUpdate', tools, available });
		});
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/** Subscribes to connection, deploy, config, and cloud-auth events. */
	private setupEventListeners(): void {
		// connectionManager.on()/deployManager.on() return the SHARED manager
		// (a Node EventEmitter), and ITS dispose() tears down the whole
		// extension's connection — disposal must wrap off() with the named
		// handler instead of disposing the return value.
		const connStateHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:statusChange', connStateHandler);
		const connectedHandler = async () => {
			// Subscribe to task lifecycle events
			const client = this.connectionManager.getClient();
			if (client) {
				// 'task' only: the wildcard 'output' subscription existed to feed
				// the removed Rocket Ride: Console mirror — per-editor monitors
				// subscribe to output themselves for the Log pane.
				client.addMonitor({ token: '*' }, ['task']).catch((err) => {
					this.logger.error(`Sidebar task-event subscription failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			// Teams come from ConnectResult — no fetch needed, just update the webview
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:connected', connectedHandler);
		const disconnectedHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:disconnected', disconnectedHandler);
		const errorHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:error', errorHandler);
		const configChange = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendFullUpdate();
			}
		});

		// Re-fetch teams when cloud auth state changes (sign-in/sign-out)
		const cloudAuth = CloudAuthProvider.getInstance();
		const cloudAuthHandler = async () => {
			this.sendFullUpdate();
		};
		cloudAuth.onDidChange.on('changed', cloudAuthHandler);

		// ── Deploy manager events ────────────────────────────────────────────
		const deployConnStateHandler = () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:statusChange', deployConnStateHandler);
		const deployConnectedHandler = async () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:connected', deployConnectedHandler);
		const deployDisconnectedHandler = () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:disconnected', deployDisconnectedHandler);

		this.disposables.push(
			{ dispose: () => this.connectionManager.off('shell:statusChange', connStateHandler) },
			{ dispose: () => this.connectionManager.off('shell:connected', connectedHandler) },
			{ dispose: () => this.connectionManager.off('shell:disconnected', disconnectedHandler) },
			{ dispose: () => this.connectionManager.off('shell:error', errorHandler) },
			configChange,
			{ dispose: () => this.deployManager.off('shell:statusChange', deployConnStateHandler) },
			{ dispose: () => this.deployManager.off('shell:connected', deployConnectedHandler) },
			{ dispose: () => this.deployManager.off('shell:disconnected', deployDisconnectedHandler) },
			{ dispose: () => cloudAuth.onDidChange.removeListener('changed', cloudAuthHandler) }
		);

		// Forward server events to webview
		// NO apaevt_task forwarding: the webview folds task events from its
		// OWN engine client now. Status updates still relay because they read
		// the canvas editor's host-side diagnostics cache (migrates with it).
		this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_status_update') {
				// Forward status updates (errors/warnings) to webview.
				// Deploy runs never touch the dev lists (THE one host-side
				// classifier, shared with PipelineProvider's status cache) —
				// their status belongs to the deployment surfaces, and the '*'
				// subscription delivers them here whenever a team-scoped run
				// is visible.
				if (isDeployRunBody(event.body)) return;
				const projectId = event.body?.project_id;
				const sourceId = event.body?.source;
				if (projectId && sourceId) {
					const statusProvider = getPipelineProvider();
					const ts = statusProvider?.getTaskStatus(projectId, sourceId);
					this._view?.webview.postMessage({
						type: 'sidebar:statusUpdate',
						projectId,
						sourceId,
						errors: ts?.errors ?? [],
						warnings: ts?.warnings ?? [],
					});
				}
			}
		});
	}

	// =========================================================================
	// UPDATES
	// =========================================================================

	/**
	 * The Dev Tools panel's RESET after a publish: re-authenticates to pull
	 * a fresh app registry (manifests, versions) from the server, recreates
	 * any open tool panel whose mounted version went stale, and reboots THIS
	 * sidebar webview so its loaded devToolSidebar containers are dropped —
	 * a loaded MF remote cannot be repointed in a live realm. The reboot is
	 * cheap by design: retained bridge state replays into the fresh realm.
	 */
	private async refreshDevTools(): Promise<void> {
		try {
			await this.connectionManager.disconnect();
			await this.connectionManager.connect();
		} catch {
			// A failed reconnect surfaces through the normal status pipeline
			// (status bar, connection rows) — nothing extra to report here.
		}
		// Open frame panels first (each is its own webview realm; stale ones
		// are disposed and recreated against the fresh catalog) ...
		await vscode.commands.executeCommand('rocketride.devtool.refreshStale');
		// ... then this sidebar's own realm.
		if (this._view) {
			this._view.webview.html = this.getHtmlForWebview(this._view.webview);
		}
	}

	/**
	 * Sends connection state + strip state to the webview — the SYNCHRONOUS
	 * local state only, posted with no awaits in front of it. After a CSP
	 * reboot this message is the wiped page's one shot at its rows, so
	 * nothing network-derived may sit between the call and the post. The
	 * slow fields (user identity, tool rows, catalog, devToolHost) follow
	 * out-of-band via {@link sendUpdateExtras}.
	 */
	private sendFullUpdate(): void {
		if (!this._view) return;

		// An engine-origin change invalidates the webview's CSP (the dev-tool
		// sidebar mounts load remote chunks from the engine): re-render the
		// HTML — the webview reboots and re-handshakes via view:ready.
		if (this.htmlEngineOrigin !== this.engineOrigin()) {
			this._view.webview.html = this.getHtmlForWebview(this._view.webview);
			return;
		}

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();
		const deployStatus = this.deployManager.getConnectionStatus();

		this._view.webview.postMessage({
			type: 'sidebar:update',
			data: {
				// Dev connection
				connectionState: status.state,
				connectionMode: config.development.connectionMode,
				devProgressMessage: status.progressMessage,
				devProgressLogLine: status.progressLogLine,
				// Deploy connection
				deployConnectionState: deployStatus.state,
				deployConnectionMode: config.deployment.connectionMode,
				deployProgressMessage: deployStatus.progressMessage,
				deployProgressLogLine: deployStatus.progressLogLine,
				// Shared
				cloudConnected: isCloudConnected(),
				// Subscription
				isSubscribed: isSubscribed(this.connectionManager.getClient(), PIPE_BUILDER_APP_ID),
				// NO entries/tasks: the webview's PIPELINES CONTROLLER discovers
				// files itself and folds task events from its own client.
				sidebarMode: this.sidebarMode,
				tabOrder: this.tabOrder,
			},
		});

		// The network-derived half rides behind, individually guarded — a
		// hung icon fetch or a failed identity lookup must not cost the rows
		// just posted.
		void this.sendUpdateExtras();
	}

	/** Monotonic extras counter — a newer compose supersedes an in-flight one. */
	private extrasSeq = 0;

	/**
	 * Composes and posts the network-derived half of a full update: user
	 * identity, pinned tool rows, the dev-tool catalog, and the devToolHost
	 * connection facts. Every await is individually guarded so one bad
	 * endpoint degrades its own field — the sync update this follows is on
	 * screen either way.
	 */
	private async sendUpdateExtras(): Promise<void> {
		const mine = ++this.extrasSeq;
		const config = this.configManager.getConfig();

		// Resolve user identity from whichever connection is cloud-connected.
		// Dev takes priority; local/docker/service connections don't have real
		// user identity. The cloud-auth name is a fallback and optional.
		const devAccount = this.connectionManager.getClient()?.getAccountInfo();
		const deployAccount = this.deployManager.getClient()?.getAccountInfo();
		const account = (config.development.connectionMode === 'cloud' ? devAccount : null) ?? (config.deployment.connectionMode === 'cloud' ? deployAccount : null);
		let cloudName: string | undefined;
		if (!account?.displayName && isCloudConnected()) {
			try {
				cloudName = await CloudAuthProvider.getInstance().getUserName();
			} catch {
				/* identity is cosmetic — never block the update on it */
			}
		}
		const userName = account?.displayName || cloudName || undefined;
		const userEmail = account?.email || undefined;

		// Pinned tool rows: fall back to the last-known cache (the strip-seed
		// source) rather than wiping the tabs — an empty list would also drop
		// a selected tool mode back to Pipelines.
		const tools = await this.toolRows.buildToolRows().catch((): ToolRowDTO[] => this.toolRows.cachedRows());
		const availableTools = await this.toolRows.buildAvailableTools().catch((): ToolRowDTO[] => []);
		// Connection facts for the sidebar's devToolSidebar mounts — the MF
		// remote entry URL ONLY. No token crosses into the webview: engine
		// access is brokered over the shell bus.
		const devToolHost = this.connectionManager.isConnected()
			? { engineHttpUrl: (this.connectionManager.getHttpUrl() || 'http://localhost:5565').replace(/\/$/, '') }
			: null;

		// Superseded by a newer full update, or the view died: drop silently.
		if (mine !== this.extrasSeq || !this._view) return;
		this._view.webview.postMessage({ type: 'sidebar:extrasUpdate', userName, userEmail, tools, availableTools, devToolHost });
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/** Reads the static HTML template and rewrites resource URIs for the webview. */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-sidebar.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Dev-tool sidebar mounts load the tool's remote FROM THE ENGINE:
			// widen the CSP with the engine origin (scripts = remote chunks;
			// styles = the remote's async CSS chunks; connect = MF fetches +
			// the mount's SDK websocket). Computed at render time; an
			// engine-origin change re-renders the HTML (see the statusChange
			// listener).
			const origin = this.engineOrigin();
			this.htmlEngineOrigin = origin;
			if (origin) {
				const wsOrigin = origin.replace(/^http/, 'ws');
				htmlContent = htmlContent
					.replace(/script-src /, `script-src ${origin} `)
					.replace(/style-src /, `style-src ${origin} `)
					.replace(/connect-src /, `connect-src ${origin} ${wsOrigin} `)
					.replace(/img-src /, `img-src ${origin} `);
			}

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading sidebar: ${error}</p></body></html>`;
		}
	}

	/**
	 * The engine origin the webview CSP should carry. getHttpUrl() is total —
	 * the live engine URI when connected, the configured hostUrl (or the
	 * local default) otherwise — so the first render already bakes the origin
	 * the connection will land on: the common startup (sidebar resolves while
	 * connecting, engine lands seconds later) produces no CSP mismatch and no
	 * webview reboot. A disconnect keeps the last expected origin for the
	 * same reason; only a genuine engine switch changes it. '' only when the
	 * URL is unparsable.
	 */
	private engineOrigin(): string {
		try {
			return new URL(this.connectionManager.getHttpUrl() || '').origin;
		} catch {
			return '';
		}
	}

	/** Generates a 32-character random nonce for Content Security Policy. */
	private generateNonce(): string {
		// Cryptographic source — a CSP nonce must be unpredictable.
		return crypto.randomBytes(24).toString('base64url');
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Unsubscribes from task events and disposes all listeners. */
	public dispose(): void {
		const client = this.connectionManager.getClient();
		if (client) {
			client.removeMonitor({ token: '*' }, ['task']).catch(() => {});
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
