// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarWebview — VS Code webview bridge for the tool-registry sidebar.
 *
 * Receives data from the extension host via useMessaging, manages local
 * state (connection state for dev and deploy, strip/tool rows, prefs
 * seed), and renders <SidebarChrome> over the builtin-tool registry plus
 * the pinned store tools, with a <SidebarFooter> footerSlot. Each builtin
 * sidebar mounts under its own ToolHostProvider carrying ITS scoped prefs
 * partition; store-tool panels mount remotely via DevToolSidebarMount.
 *
 * The seams live in sibling modules:
 *   - messages.ts     — both typed ends of the wire vocabulary
 *   - shell busPeer — stable tool peers over the bus's retained/signal lanes
 *   - svcFsClient.ts  — the ToolWorkspaceFs capability (svc:fs RPC)
 *   - footerMenu.tsx  — the footer popup items from connection facts
 *
 * Architecture:
 *   SidebarProvider (Node.js) ↔ postMessage ↔ SidebarWebview (browser)
 *     → SidebarChrome (shared) + SidebarFooter (shared)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import './sidebar.css';

import { SidebarChrome, ToolPanel } from 'shared/tools/core/chrome/SidebarChrome';
import { ToolHostProvider } from 'shared/tools/core';
import { useToolStrip } from 'shared/tools/core/chrome/useToolStrip';
import type { BuiltinToolServices } from 'shared/tools/core';
import { ConnectionManager, SidebarFooter, createBridgedPrefsStore, createSidebarBusPeer } from 'shell';
import { registerBuiltinTools } from 'shared/tools/builtins';
import { pushSourceDiagnostics } from 'shared/tools/pipelines/diagnostics';
import type { ConnectionInfo, SidebarMode, ToolTab } from 'shared/tools/core/chrome/types';
import { useMessaging } from '../hooks/useMessaging';
import { DevToolSidebarMount } from './DevToolSidebarMount';
import type { DevToolHostInfo } from './DevToolSidebarMount';
import type { SidebarHostToWebview, SidebarWebviewToHost } from './messages';
import { createSvcFsClient } from './svcFsClient';
import { buildFooterMenuItems } from './footerMenu';
import { attachBusRealm } from '../hooks/busRealm';

// A TOOL IS AN APP: the builtin tools register once per realm; this host's
// sidebar renders them by iterating the registry.
registerBuiltinTools();

// SHELL BUS SPOKE: attach this realm to the extension host's router once
// per realm lifetime — request('client.*') reaches the broker, the mirror
// feed re-emits root state locally (busRealm.ts).


const SidebarViewWebview: React.FC = () => {
	// Attach this realm to the shell bus FIRST (idempotent; failure-isolated
	// inside) — mirror state and brokered client.* ops ride it.
	attachBusRealm();

	// ── Dev connection state ────────────────────────────────────────────────
	const [connection, setConnection] = useState<ConnectionInfo>({ state: 'disconnected' });
	const [developmentMode, setDevelopmentMode] = useState('local');
	const [devProgressMessage, setDevProgressMessage] = useState<string | undefined>();

	// ── Subscription state ─────────────────────────────────────────────────
	const [subscribed, setSubscribed] = useState(true);

	// ── Deploy connection state ─────────────────────────────────────────────
	const [deployConnectionState, setDeployConnectionState] = useState('disconnected');
	const [deployTargetMode, setDeployTargetMode] = useState<string | null>(null);
	const [deployProgressMessage, setDeployProgressMessage] = useState<string | undefined>();

	// Entries, tasks, and the MY APPS list live in the TOOLS now (shared
	// tools/pipelines, tools/appdev) — this webview only provides services.

	// Builtin tools the user DISABLED (host-persisted; seeded by stripSeed).
	const [disabledBuiltins, setDisabledBuiltins] = useState<string[]>([]);

	// ── Pinned dev tools (icon tabs on the mode strip) + the catalog ───────
	const [tools, setTools] = useState<ToolTab[]>([]);
	const [availableTools, setAvailableTools] = useState<ToolTab[]>([]);
	// Persisted strip order (modes + tool tabs); seeded from the host, set
	// optimistically on drag.
	const [tabOrder, setTabOrder] = useState<string[]>([]);
	const [devToolHost, setDevToolHost] = useState<DevToolHostInfo | null>(null);
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>('apps');
	// Tools whose sidebar mount has been ACTIVATED — a tool pane loads its
	// remote only once its tab has been selected (user click, or host focus
	// sync from its frame panel); never merely because the tool is pinned.
	const [activatedTools, setActivatedTools] = useState<ReadonlySet<string>>(new Set());
	// The editor's fronted tool document (host-tracked). undefined = no
	// signal received yet (mounts fall back to their own state); appId null
	// = a non-tool tab is fronted.
	const [activeToolDoc, setActiveToolDoc] = useState<{ appId: string | null; docKey: string | null } | undefined>(undefined);
	// The host-persisted mode seeds the strip ONCE: an `update` composed
	// before the persist round trip completed carries the previous value and
	// must not revert a selection the user just made.
	const sidebarModeSeededRef = useRef(false);

	// ── Engine progress log (last N lines for popup display) ───────────────
	const MAX_PROGRESS_LINES = 15;
	const [devProgressLog, setDevProgressLog] = useState<string[]>([]);
	const [deployProgressLog, setDeployProgressLog] = useState<string[]>([]);

	// ── Shared auth + identity ──────────────────────────────────────────────
	const [userName, setUserName] = useState<string | undefined>();
	const [userEmail, setUserEmail] = useState<string | undefined>();
	const [cloudConnected, setCloudSignedIn] = useState(false);

	// ── Messaging ───────────────────────────────────────────────────────────

	const { sendMessage } = useMessaging<SidebarWebviewToHost, SidebarHostToWebview>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'sidebar:update':
					setConnection({
						state: msg.data.connectionState as ConnectionInfo['state'],
						mode: msg.data.connectionMode,
					});
					// No entries here: the PIPELINES CONTROLLER in this webview
					// discovers them (shared tools/pipelines over svc:fs).
					// Shared auth
					if (msg.data.cloudConnected !== undefined) setCloudSignedIn(msg.data.cloudConnected);

					// Dev connection state
					if (msg.data.connectionMode) setDevelopmentMode(msg.data.connectionMode);
					setDevProgressMessage(msg.data.devProgressMessage);

					// Accumulate dev engine log lines; clear on connect
					if (msg.data.connectionState === 'connected') {
						setDevProgressLog([]);
					} else if (msg.data.devProgressLogLine) {
						setDevProgressLog((prev) => (prev[prev.length - 1] === msg.data.devProgressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), msg.data.devProgressLogLine!]));
					}

					// Deploy connection state
					if (msg.data.deployConnectionState) setDeployConnectionState(msg.data.deployConnectionState);
					if (msg.data.deployConnectionMode !== undefined) setDeployTargetMode(msg.data.deployConnectionMode ?? null);
					setDeployProgressMessage(msg.data.deployProgressMessage);

					// Accumulate deploy engine log lines; clear on connect
					if (msg.data.deployConnectionState === 'connected') {
						setDeployProgressLog([]);
					} else if (msg.data.deployProgressLogLine) {
						setDeployProgressLog((prev) => (prev[prev.length - 1] === msg.data.deployProgressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), msg.data.deployProgressLogLine!]));
					}
					// Subscription status
					if (msg.data.isSubscribed !== undefined) setSubscribed(msg.data.isSubscribed);
					// Host-persisted mode (seed once — see ref) + strip order
					if (msg.data.tabOrder) setTabOrder(msg.data.tabOrder);
					if (msg.data.sidebarMode && !sidebarModeSeededRef.current) {
						sidebarModeSeededRef.current = true;
						setSidebarMode(msg.data.sidebarMode);
					}
					break;

				case 'sidebar:toolsUpdate':
					setTools(msg.tools);
					setAvailableTools(msg.available);
					break;

				case 'sidebar:extrasUpdate':
					// The slow half of a full update — the sync half (apps,
					// entries, connection state) is already on screen.
					if (msg.userName !== undefined) setUserName(msg.userName || undefined);
					if (msg.userEmail !== undefined) setUserEmail(msg.userEmail || undefined);
					setTools(msg.tools);
					setAvailableTools(msg.availableTools);
					setDevToolHost(msg.devToolHost);
					break;

				case 'sidebar:stripSeed':
					// Synchronous strip bootstrap (first message after
					// view:ready): pinned tools with their last-known icons,
					// the persisted order, and the persisted mode — the strip
					// paints its final shape at once instead of reshuffling as
					// account data trickles in. The full update's fresh rows
					// replace these in place.
					setTools(msg.tools);
					setTabOrder(msg.tabOrder);
					if (msg.disabledBuiltins) setDisabledBuiltins(msg.disabledBuiltins);
					if (!sidebarModeSeededRef.current) {
						sidebarModeSeededRef.current = true;
						setSidebarMode(msg.sidebarMode);
					}
					break;

				case 'prefs:init':
					// Hydrates the realm's prefs store (resolves its `ready`).
					prefsBridge.seed(msg.values);
					break;

				case 'devtool:activeDoc':
					setActiveToolDoc({ appId: msg.appId, docKey: msg.docKey });
					break;

				case 'svc:fs:result':
					svcFs.onResult(msg);
					break;

				case 'svc:fs:event':
					svcFs.onEvent(msg);
					break;

				case 'sidebar:modeUpdate':
					// Host-driven selection (a tool panel gained focus) — unlike
					// the full-update seed, this ALWAYS applies.
					sidebarModeSeededRef.current = true;
					setSidebarMode(msg.mode);
					break;

				case 'sidebar:statusUpdate':
					// Per-source diagnostics from the canvas editor's host-side
					// cache — pushed into the PIPELINES TOOL's ingress.
					pushSourceDiagnostics({ projectId: msg.projectId, sourceId: msg.sourceId, errors: msg.errors, warnings: msg.warnings });
					break;

			}
		},
	});

	// The clients below are created ONCE and capture the latest sendMessage
	// through this ref — their identities (and every peer/capability they
	// hand out) stay stable for the realm's lifetime.
	const sendRef = useRef(sendMessage);
	sendRef.current = sendMessage;

	// ── Workspace-FS capability ─────────────────────────────────────────────
	// The ToolWorkspaceFs the shared tool code runs against; its svc:fs
	// request/response + watch traffic routes through the message switch.
	const svcFs = useMemo(() => createSvcFsClient((m) => sendRef.current(m)), []);

	// ── Tool peers (bus-carried) ────────────────────────────────────────────
	// Stable sidebar-side peers per tool, riding the bus's retained/signal
	// lanes (shell busPeer): frame traffic arrives on the tool's topics, and
	// each peer holds payloads until the tool's lazy mount subscribes.
	const sidebarPeers = useMemo(() => {
		const cache = new Map<string, ReturnType<typeof createSidebarBusPeer>>();
		return (appId: string) => {
			let peer = cache.get(appId);
			if (!peer) {
				peer = createSidebarBusPeer(appId, ConnectionManager.getInstance());
				cache.set(appId, peer);
			}
			return peer;
		};
	}, []);

	// This realm's prefs backend: a hydrate-once bridged store — the host
	// seeds the snapshot in its view:ready reply (prefs:init) and persists
	// writes (prefs:set) into its Memento bags. Per-tool partitions are
	// carved off it in the builtin strip items.
	const prefsBridge = useMemo(() => createBridgedPrefsStore((key, value, scope) => sendRef.current({ type: 'prefs:set', key, value, scope })), []);

	// NO realm socket: the controllers reach the engine over the SHELL BUS
	// (request('client.*') to the extension host's broker), and the realm
	// singleton's connection state is bus-mirrored (busRealm.ts). The
	// devToolHost facts carry only the MF entry URL now.

	// The PIPELINES and APPDEV controllers run inside their TOOLS (shared
	// tools/pipelines, tools/appdev) against the services provided below.

	// ── Host verbs for the tools ─────────────────────────────────────────────

	const onOpenFile = useCallback(
		(path: string) => {
			sendMessage({ type: 'sidebar:openFile', fsPath: path });
		},
		[sendMessage]
	);

	const onSourceAction = useCallback(
		(action: string, filePath: string, sourceId: string, projectId?: string) => {
			switch (action) {
				case 'run':
					sendMessage({ type: 'sidebar:runPipeline', fsPath: filePath, sourceId });
					break;
				case 'stop':
					if (projectId) sendMessage({ type: 'sidebar:stopPipeline', projectId, sourceId });
					break;
			}
		},
		[sendMessage]
	);

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'sidebar:command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);

	const onOpenUnknownTask = useCallback(
		(projectId: string, sourceId: string, displayName: string) => {
			sendMessage({ type: 'sidebar:openUnknownTask', projectId, sourceId, displayName });
		},
		[sendMessage]
	);

	/** The tools' generic page surface, mapped onto this host's pages. Keys
	 *  this host has no page for ('desktop', 'agent:<id>') no-op. */
	const openPage = useCallback((key: string) => {
		if (key.startsWith('intro:')) {
			sendMessage({ type: 'sidebar:command', command: 'rocketride.page.intro.open', args: [key.slice('intro:'.length)] });
			return;
		}
		if (key === 'newapp') {
			sendMessage({ type: 'sidebar:command', command: 'rocketride.app.create' });
			return;
		}
		if (key.startsWith('app:')) {
			sendMessage({ type: 'sidebar:openApp', appId: key.slice('app:'.length) });
			return;
		}
	}, [sendMessage]);

	// The ONE services object the builtin tools read (ToolContext). Tools
	// own their state; this host contributes generic verbs plus the
	// workspace-FS capability its extension host serves.
	const toolServices = useMemo<BuiltinToolServices>(() => ({
		workspaceFs: svcFs.workspaceFs,
		openPage,
		openFile: onOpenFile,
		pipelineAction: onSourceAction,
		newPipeline: () => sendRef.current({ type: 'sidebar:command', command: 'rocketride.sidebar.files.createFile' }),
		openUnknownTask: onOpenUnknownTask,
		isSubscribed: subscribed,
	}), [svcFs, openPage, onOpenFile, onSourceAction, onOpenUnknownTask, subscribed]);

	/** Flips one builtin's enabled state (optimistic; host persists). */
	const onToggleBuiltin = useCallback((id: string, enabled: boolean) => {
		setDisabledBuiltins((prev) => {
			const next = enabled ? prev.filter((d) => d !== id) : [...prev.filter((d) => d !== id), id];
			sendMessage({ type: 'sidebar:setDisabledBuiltins', ids: next });
			return next;
		});
	}, [sendMessage]);

	// Shared builtin-strip glue: items (with per-tool scoped prefs), store
	// rows, and the activation/deactivation discipline. Builtins have no
	// isolated frame document in this host, so the hook's stable loopback
	// peers satisfy the contract.
	const revealTool = useCallback((toolId: string) => {
		sendMessage({ type: 'sidebar:focusTool', toolId });
	}, [sendMessage]);
	const { builtinItems, builtinStoreRows, focusTool: onFocusTool, deactivateReplacedTab, announceBuiltinSelected } = useToolStrip({
		host: 'vscode',
		services: toolServices,
		prefsStore: prefsBridge.store,
		disabledBuiltins,
		revealTool,
	});

	// ── Store-tool callbacks ────────────────────────────────────────────────

	/** Tool tab → open/focus the tool's frame panel (extension host). */
	const onOpenTool = useCallback((toolId: string) => {
		sendMessage({ type: 'sidebar:openTool', toolId });
	}, [sendMessage]);

	/** Tool panel Remove row → unpin (extension host persists). */
	const onRemoveTool = useCallback((toolId: string) => {
		sendMessage({ type: 'sidebar:removeTool', toolId });
	}, [sendMessage]);

	/** Dev Tools panel RESET → ext host re-fetches the app registry and
	 *  reloads every loaded tool (stale frame panels + this webview). */
	const onRefreshTools = useCallback(() => {
		sendMessage({ type: 'sidebar:refreshTools' });
	}, [sendMessage]);

	/** Modules-list row → the tool's details page (README + Install/Remove). */
	const onShowTool = useCallback((toolId: string) => {
		sendMessage({ type: 'sidebar:showToolReadme', toolId });
	}, [sendMessage]);

	/** Drag-reorder → apply optimistically, host persists to workspace state. */
	const onReorderTabs = useCallback((orderedIds: string[]) => {
		setTabOrder(orderedIds);
		sendMessage({ type: 'sidebar:reorderTabs', order: orderedIds });
	}, [sendMessage]);

	// Lazy activation: a tool's sidebar mount loads only once its tab has been
	// selected — by the user, or by the host syncing focus from the tool's
	// frame panel (modeUpdate). Activation is sticky for the document's
	// lifetime so TabPanel's keep-mounted semantics preserve its state.
	useEffect(() => {
		if (!sidebarMode.startsWith('tool:')) return;
		const id = sidebarMode.slice('tool:'.length);
		setActivatedTools((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, [sidebarMode]);

	/** Stable documents API for one tool's sidebar mount — opens/closes the
	 *  tool's per-document editor panels (e.g. one per database connection)
	 *  through the extension host. One object per tool, like the peers. */
	const documentsRef = useRef(new Map<string, { open: (docKey: string, title: string) => void; close: (docKey: string) => void }>());
	const getDocumentsApi = useCallback((appId: string) => {
		const cached = documentsRef.current.get(appId);
		if (cached) return cached;
		const api = {
			open: (docKey: string, title: string) => sendRef.current({ type: 'sidebar:openToolDocument', appId, docKey, title }),
			close: (docKey: string) => sendRef.current({ type: 'sidebar:closeToolDocument', appId, docKey }),
		};
		documentsRef.current.set(appId, api);
		return api;
	}, []);

	/** Tool tab body — the tool's devToolSidebar mounted natively, falling
	 *  back to the built-in card when the tool declares none. Tools never
	 *  activated render just the card: pinning N tools must not boot N
	 *  remotes (and their SDK connections) behind hidden tabs. */
	const renderToolPanel = useCallback((id: string): React.ReactNode => {
		const tool = tools.find((t) => t.id === id);
		if (!tool) return null;
		const card = <ToolPanel tool={tool} onOpen={onOpenTool} onRemove={onRemoveTool} />;
		if (!activatedTools.has(id)) return card;
		// Host-tracked selection for THIS tool: its fronted docKey, null when
		// another tab is fronted, undefined before any signal arrived.
		const activeDocKey = activeToolDoc === undefined ? undefined : (activeToolDoc.appId === id ? activeToolDoc.docKey : null);
		return (
			<DevToolSidebarMount
				tool={tool}
				host={devToolHost}
				peer={sidebarPeers(id)}
				documents={getDocumentsApi(id)}
				{...(activeDocKey !== undefined ? { activeDocKey } : {})}
				fallback={card}
			/>
		);
	}, [tools, devToolHost, activatedTools, activeToolDoc, sidebarPeers, getDocumentsApi, onOpenTool, onRemoveTool]);

	// The TRUE previous mode, mirrored from state so externally applied
	// changes (modeUpdate, stripSeed) update it silently — only a chrome
	// selection below emits the deactivation for the tab it replaces.
	const prevSidebarModeRef = useRef<SidebarMode>(sidebarMode);
	useEffect(() => { prevSidebarModeRef.current = sidebarMode; }, [sidebarMode]);

	/** Mode strip selection — local state now, host persists via message. */
	const onSidebarModeChange = useCallback(
		(mode: SidebarMode) => {
			deactivateReplacedTab(prevSidebarModeRef.current, mode);
			// Builtins mount in the strip itself — their activation (the
			// single-pane contract) rides the selection; MF pins get theirs
			// via SidebarChrome's onFocusTool.
			announceBuiltinSelected(mode);
			// A user selection counts as the seed: an `update` composed before
			// the persist round trip completed must not revert it.
			sidebarModeSeededRef.current = true;
			setSidebarMode(mode);
			sendMessage({ type: 'sidebar:setSidebarMode', mode });
		},
		[sendMessage, deactivateReplacedTab, announceBuiltinSelected]
	);

	// ── Footer ──────────────────────────────────────────────────────────────
	// Items derive from the connection facts (footerMenu.tsx); clicks run
	// extension-host commands.
	const runCommand = useCallback((command: string, args?: unknown[]) => {
		sendMessage({ type: 'sidebar:command', command, ...(args !== undefined ? { args } : {}) });
	}, [sendMessage]);

	const footerMenuItems = useMemo(
		() =>
			buildFooterMenuItems(
				{
					connectionState: connection.state,
					developmentMode,
					devProgressMessage,
					devProgressLog,
					deployConnectionState,
					deployTargetMode,
					deployProgressMessage,
					deployProgressLog,
					cloudConnected,
					subscribed,
				},
				runCommand
			),
		[connection.state, developmentMode, devProgressMessage, devProgressLog, deployConnectionState, deployTargetMode, deployProgressMessage, deployProgressLog, cloudConnected, subscribed, runCommand]
	);

	const footerSlot = <SidebarFooter collapsed={false} userName={userName} userEmail={userEmail} onOpenDocs={onOpenDocs} menuItems={footerMenuItems} />;

	// ── Render ───────────────────────────────────────────────────────────────

	// No headerSlot: the VS Code host has no home-app destination, so it injects no
	// host-specific top nav. The "Home" button is a SaaS-shell concept owned by the
	// web host (rocket-ui), intentionally absent from shared / this extension.

	return (
		<ToolHostProvider value={toolServices}>
			<SidebarChrome items={builtinItems} footerSlot={footerSlot} sidebarMode={sidebarMode} onSidebarModeChange={onSidebarModeChange} toolTabs={{ tools, available: availableTools, onOpenTool, onFocusTool, onShowTool, onRemoveTool, onRefreshTools, renderToolPanel, builtins: builtinStoreRows, onToggleBuiltin }} tabOrder={tabOrder} onReorderTabs={onReorderTabs} />
		</ToolHostProvider>
	);
};

export default SidebarViewWebview;
