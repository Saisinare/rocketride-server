// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarViewWebview — VS Code webview bridge for the unified sidebar.
 *
 * Receives data from the extension host via useMessaging, manages local
 * state (active tasks, unknown tasks, connection state for both dev and
 * deploy), and renders <SidebarView> with a <SidebarFooter> footerSlot.
 *
 * The footer menu is built dynamically based on auth and connection state:
 *   - Anonymous (no cloud identity): Development Mode + Settings only
 *   - Cloud signed in: Development Mode + Deploy Target + Account/Billing/Settings/Log out
 *
 * Team submenus under Cloud are populated from the respective connection's
 * server (dev teams from ConnectionManager, deploy teams from DeployManager).
 *
 * Architecture:
 *   SidebarProvider (Node.js) ↔ postMessage ↔ SidebarViewWebview (browser)
 *     → SidebarView (shared) + SidebarFooter (shared)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import './sidebar.css';

import { SidebarChrome } from 'shared/tools/core/chrome/SidebarChrome';
import type { SidebarToolItem } from 'shared/tools/core/chrome/SidebarChrome';
import { getBuiltinTools, ToolHostProvider, createLoopbackPeer } from 'shared/tools/core';
import type { BuiltinToolServices } from 'shared/tools/core';
import { createBridgedPrefsStore, scopedPrefs } from 'shell';
import { registerBuiltinTools } from 'shared/tools/builtins';
import { pushSourceDiagnostics } from 'shared/tools/pipelines/diagnostics';
import { BxUser, BxCog, BxExport, BxLock, BxRocket } from 'shell';
import { SidebarFooter } from 'shell';
import type { SidebarFooterMenuItem } from 'shell';
import type { ConnectionInfo, SidebarMode, ToolTab } from 'shared/tools/core/chrome/types';
import type { AppListItem } from 'shared/tools/appdev/sidebarTypes';
import { useMessaging } from '../hooks/useMessaging';
import { ConnectionManager } from 'shell';
import type { ToolWorkspaceFs } from 'shell';
import { DevToolSidebarMount } from './DevToolSidebarMount';
import type { DevToolHostInfo } from './DevToolSidebarMount';
import { ToolPanel } from 'shared/tools/core/chrome/SidebarChrome';

// A TOOL IS AN APP: the builtin tools register once per realm; this host's
// sidebar renders them by iterating the registry.
registerBuiltinTools();

// =============================================================================
// TYPES — messages between extension host and webview
// =============================================================================

type OutgoingMessage = { type: 'view:ready' } | { type: 'command'; command: string; args?: unknown[] } | { type: 'openFile'; fsPath: string } | { type: 'runPipeline'; fsPath: string; sourceId?: string } | { type: 'stopPipeline'; projectId: string; sourceId: string } | { type: 'openUnknownTask'; projectId: string; sourceId: string; displayName: string } | { type: 'openApp'; appId: string } | { type: 'setSidebarMode'; mode: SidebarMode } | { type: 'openTool'; toolId: string } | { type: 'focusTool'; toolId: string } | { type: 'refreshTools' } | { type: 'removeTool'; toolId: string } | { type: 'showToolReadme'; toolId: string } | { type: 'reorderTabs'; order: string[] } | { type: 'setDisabledBuiltins'; ids: string[] } | { type: 'prefs:set'; key: string; value: unknown; scope: 'workspace' | 'global' } | { type: 'devtool:peer'; appId: string; payload: unknown } | { type: 'openToolDocument'; appId: string; docKey: string; title: string } | { type: 'closeToolDocument'; appId: string; docKey: string } | { type: 'svc:fs'; id: number; method: 'findFiles'; include: string; exclude?: string } | { type: 'svc:fs'; id: number; method: 'workspaceRoots' } | { type: 'svc:fs'; id: number; method: 'readText'; path: string } | { type: 'svc:fs'; id: number; method: 'readBase64'; path: string; maxBytes: number } | { type: 'svc:fs:watch'; id: number; globs: string[] } | { type: 'svc:fs:unwatch'; id: number };

type IncomingMessage =
	| {
			type: 'update';
			data: {
				// Dev connection
				connectionState: string;
				connectionMode: string;
				devProgressMessage?: string;
				devProgressLogLine?: string;
				// Deploy connection
				deployConnectionState?: string;
				deployConnectionMode?: string | null;
				deployProgressMessage?: string;
				deployProgressLogLine?: string;
				// Shared auth
				cloudConnected?: boolean;
				/** Active pipeBuilder subscription (gates subscription-only UI). */
				isSubscribed?: boolean;
				/** Host-persisted sidebar mode (workspaceState). */
				sidebarMode?: SidebarMode;
				/** Host-persisted strip tab order (workspaceState). */
				tabOrder?: string[];
			};
	  }
	// The network-derived half of a full update: identity, pinned tool rows,
	// the dev-tool catalog, and the devToolSidebar connection facts — posted
	// separately so these slow lookups can never delay or drop the sync half.
	| { type: 'extrasUpdate'; userName?: string; userEmail?: string; tools: ToolTab[]; availableTools: ToolTab[]; devToolHost: DevToolHostInfo | null }
	| { type: 'toolsUpdate'; tools: ToolTab[]; available: ToolTab[] }
	| { type: 'stripSeed'; tools: ToolTab[]; tabOrder: string[]; sidebarMode: SidebarMode; disabledBuiltins?: string[] }
	| { type: 'prefs:init'; values: Record<string, unknown> }
	| { type: 'devtool:activeDoc'; appId: string | null; docKey: string | null }
	| { type: 'devtool:peer'; appId: string; payload: unknown }
	| { type: 'svc:fs:result'; id: number; ok: boolean; result?: unknown; error?: string }
	| { type: 'svc:fs:event'; id: number; path: string }
	| { type: 'modeUpdate'; mode: SidebarMode }
	| { type: 'statusUpdate'; projectId: string; sourceId: string; errors: string[]; warnings: string[] };

// =============================================================================
// COMPONENT
// =============================================================================

const SidebarViewWebview: React.FC = () => {
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

	// ── Tool-host service client (workspace FS) ─────────────────────────────
	// Request/response correlation + watch fan-out for the svc:fs RPC. Refs,
	// so the messaging callback below never re-subscribes.
	const svcSeqRef = useRef(0);
	const svcPendingRef = useRef(new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>());
	const svcWatchRef = useRef(new Map<number, (path: string) => void>());
	// ── Pinned dev tools (icon tabs on the mode strip) + the catalog ───────
	const [tools, setTools] = useState<ToolTab[]>([]);
	const [availableTools, setAvailableTools] = useState<ToolTab[]>([]);
	// Persisted strip order (modes + tool tabs); seeded from the host, set
	// optimistically on drag.
	const [tabOrder, setTabOrder] = useState<string[]>([]);
	const [devToolHost, setDevToolHost] = useState<DevToolHostInfo | null>(null);
	// Peer subscribers per tool — host-relayed messages from the tool's frame
	// panel fan out here; a ref so the message handler never re-subscribes.
	const peerSubsRef = useRef(new Map<string, Set<(msg: unknown) => void>>());
	// Peer messages that arrived for a tool with NO subscriber yet (its mount
	// is still loading, or lazy activation hasn't mounted it at all) — held
	// per tool and replayed to the first subscriber. Bounded; oldest evicted,
	// so the latest state pushes always survive.
	const peerPendingRef = useRef(new Map<string, unknown[]>());
	// Stable peer channel objects per tool — identity matters downstream
	// (mounted sidebars memoize their bridges on it).
	const peersRef = useRef(new Map<string, { post: (message: unknown) => void; subscribe: (cb: (message: unknown) => void) => () => void }>());
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

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'update':
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
					} else if (msg.data.devProgressLogLine && msg.data.devProgressLogLine !== devProgressLog[devProgressLog.length - 1]) {
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

				case 'toolsUpdate':
					setTools(msg.tools);
					setAvailableTools(msg.available);
					break;

				case 'extrasUpdate':
					// The slow half of a full update — the sync half (apps,
					// entries, connection state) is already on screen.
					if (msg.userName !== undefined) setUserName(msg.userName || undefined);
					if (msg.userEmail !== undefined) setUserEmail(msg.userEmail || undefined);
					setTools(msg.tools);
					setAvailableTools(msg.availableTools);
					setDevToolHost(msg.devToolHost);
					break;

				case 'stripSeed':
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

				case 'svc:fs:result': {
					const pending = svcPendingRef.current.get(msg.id);
					if (pending) {
						svcPendingRef.current.delete(msg.id);
						if (msg.ok) pending.resolve(msg.result);
						else pending.reject(new Error(msg.error ?? 'workspace-fs service error'));
					}
					break;
				}

				case 'svc:fs:event':
					svcWatchRef.current.get(msg.id)?.(msg.path);
					break;

				case 'devtool:peer': {
					// Frame → this tool's sidebar mount (opaque payload).
					const subs = peerSubsRef.current.get(msg.appId);
					if (!subs || subs.size === 0) {
						// No subscriber yet (mount loading, or not activated):
						// hold for replay — keep the LATEST 64, evicting oldest.
						const pending = peerPendingRef.current.get(msg.appId) ?? [];
						pending.push(msg.payload);
						if (pending.length > 64) pending.shift();
						peerPendingRef.current.set(msg.appId, pending);
						break;
					}
					for (const cb of subs) cb(msg.payload);
					break;
				}

				case 'modeUpdate':
					// Host-driven selection (a tool panel gained focus) — unlike
					// the full-update seed, this ALWAYS applies.
					sidebarModeSeededRef.current = true;
					setSidebarMode(msg.mode);
					break;

				case 'statusUpdate':
					// Per-source diagnostics from the canvas editor's host-side
					// cache — pushed into the PIPELINES TOOL's ingress.
					pushSourceDiagnostics({ projectId: msg.projectId, sourceId: msg.sourceId, errors: msg.errors, warnings: msg.warnings });
					break;

			}
		},
	});

	// ── Workspace-FS capability ─────────────────────────────────────────────
	// The ToolWorkspaceFs the shared tool code runs against: requests ride
	// the message channel to the host's generic service; watch events fan out
	// via the refs above. Stable identity — one standing discovery loop.
	const workspaceFs = useMemo<ToolWorkspaceFs>(() => {
		const request = (message: OutgoingMessage & { id: number }): Promise<unknown> =>
			new Promise((resolve, reject) => {
				svcPendingRef.current.set(message.id, { resolve, reject });
				sendMessage(message);
			});
		return {
			findFiles: (include, exclude) =>
				request({ type: 'svc:fs', id: ++svcSeqRef.current, method: 'findFiles', include, ...(exclude !== undefined ? { exclude } : {}) }) as Promise<string[]>,
			workspaceRoots: () =>
				request({ type: 'svc:fs', id: ++svcSeqRef.current, method: 'workspaceRoots' }) as Promise<string[]>,
			readTextFile: (path) =>
				request({ type: 'svc:fs', id: ++svcSeqRef.current, method: 'readText', path }) as Promise<string>,
			readFileBase64: (path, maxBytes) =>
				request({ type: 'svc:fs', id: ++svcSeqRef.current, method: 'readBase64', path, maxBytes }) as Promise<string | null>,
			watch: (globs, onEvent) => {
				const id = ++svcSeqRef.current;
				svcWatchRef.current.set(id, onEvent);
				sendMessage({ type: 'svc:fs:watch', id, globs });
				return () => {
					svcWatchRef.current.delete(id);
					sendMessage({ type: 'svc:fs:unwatch', id });
				};
			},
		};
	}, [sendMessage]);


	// ── This webview's OWN engine connection ────────────────────────────────
	// The controllers talk to the engine directly (services catalog, task
	// events, dashboard) — no extension-host relay. Connect the realm's
	// shell singleton from the host-delivered facts; reconnects follow a
	// changed engine URL automatically (initialize is idempotent per URI).
	useEffect(() => {
		if (!devToolHost) return;
		const cm = ConnectionManager.getInstance();
		cm.initialize({ uri: devToolHost.engineHttpUrl });
		if (!cm.isConnected()) void cm.connect(devToolHost.authToken || undefined).catch(() => { /* retried on the next facts push */ });
	}, [devToolHost]);

	// The PIPELINES and APPDEV controllers run inside their TOOLS (shared
	// tools/pipelines, tools/appdev) against the services provided below.

	// ── Callbacks for SidebarView ────────────────────────────────────────────

	const onNavigate = useCallback(
		(target: string) => {
			const commands: Record<string, string> = {
				new: 'rocketride.sidebar.files.createFile',
			};
			const cmd = commands[target];
			if (cmd) sendMessage({ type: 'command', command: cmd });
		},
		[sendMessage]
	);

	const onOpenFile = useCallback(
		(path: string) => {
			sendMessage({ type: 'openFile', fsPath: path });
		},
		[sendMessage]
	);

	const onSourceAction = useCallback(
		(action: string, filePath: string, sourceId: string, projectId?: string) => {
			switch (action) {
				case 'run':
					sendMessage({ type: 'runPipeline', fsPath: filePath, sourceId });
					break;
				case 'stop':
					if (projectId) sendMessage({ type: 'stopPipeline', projectId, sourceId });
					break;
			}
		},
		[sendMessage]
	);

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);


	const onOpenUnknownTask = useCallback(
		(projectId: string, sourceId: string, displayName: string) => {
			sendMessage({ type: 'openUnknownTask', projectId, sourceId, displayName });
		},
		[sendMessage]
	);

	/** The tools' generic page surface, mapped onto this host's pages. Keys
	 *  this host has no page for ('desktop', 'agent:<id>') no-op. */
	const openPage = useCallback((key: string) => {
		if (key.startsWith('intro:')) {
			sendMessage({ type: 'command', command: 'rocketride.page.intro.open', args: [key.slice('intro:'.length)] });
			return;
		}
		if (key === 'newapp') {
			sendMessage({ type: 'command', command: 'rocketride.app.create' });
			return;
		}
		if (key.startsWith('app:')) {
			sendMessage({ type: 'openApp', appId: key.slice('app:'.length) });
			return;
		}
	}, [sendMessage]);

	// The ONE services object the builtin tools read (ToolContext). Tools
	// own their state; this host contributes generic verbs plus the
	// workspace-FS capability its extension host serves.
	const toolServices = useMemo<BuiltinToolServices>(() => ({
		workspaceFs,
		openPage,
		openFile: onOpenFile,
		pipelineAction: onSourceAction,
		newPipeline: () => onNavigate('new'),
		openUnknownTask: onOpenUnknownTask,
		isSubscribed: subscribed,
	}), [workspaceFs, openPage, sendMessage, onOpenFile, onSourceAction, onNavigate, onOpenUnknownTask, subscribed]);

	// The builtin tool tabs, straight off the registry — ordinary DevTool
	// mounts; builtins have no isolated frame document in this host, so a
	// loopback peer satisfies the contract. Peers are cached per tool so
	// mount identities stay stable across renders.
	const builtinPeersRef = useRef(new Map<string, ReturnType<typeof createLoopbackPeer>>());

	// This realm's prefs backend: a hydrate-once bridged store — the host
	// seeds the snapshot in its view:ready reply (prefs:init) and persists
	// writes (prefs:set) into its Memento bags. Per-tool partitions are
	// carved off it in the builtin render wrappers below.
	const sendMessageRef2 = useRef(sendMessage);
	sendMessageRef2.current = sendMessage;
	const prefsBridgeRef = useRef<ReturnType<typeof createBridgedPrefsStore> | null>(null);
	if (!prefsBridgeRef.current) {
		prefsBridgeRef.current = createBridgedPrefsStore((key, value, scope) => sendMessageRef2.current({ type: 'prefs:set', key, value, scope }));
	}
	const prefsBridge = prefsBridgeRef.current;
	/** Flips one builtin's enabled state (optimistic; host persists). */
	const onToggleBuiltin = useCallback((id: string, enabled: boolean) => {
		setDisabledBuiltins((prev) => {
			const next = enabled ? prev.filter((d) => d !== id) : [...prev.filter((d) => d !== id), id];
			sendMessage({ type: 'setDisabledBuiltins', ids: next });
			return next;
		});
	}, [sendMessage]);

	/** Store rows for the builtin tools (enable/disable, never uninstall). */
	const builtinStoreRows = useMemo(() =>
		getBuiltinTools()
			.filter((t) => !t.hosts || t.hosts.includes('vscode'))
			.map((t) => ({ id: t.id, name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), enabled: !disabledBuiltins.includes(t.id) })),
	[disabledBuiltins]);

	const builtinItems = useMemo<SidebarToolItem[]>(() =>
		getBuiltinTools()
			.filter((t) => (!t.hosts || t.hosts.includes('vscode')) && !disabledBuiltins.includes(t.id))
			.map((t) => {
				const Sidebar = t.sidebar;
				let peer = builtinPeersRef.current.get(t.id);
				if (!peer) {
					peer = createLoopbackPeer();
					builtinPeersRef.current.set(t.id, peer);
				}
				const toolPeer = peer;
				return {
					id: t.id,
					label: t.name,
					...(t.icon !== undefined ? { icon: t.icon } : {}),
					// Nested provider: this tool's services carry ITS prefs
					// partition — a tool's handle cannot address another
					// app's keys (isolation by construction).
					render: () => (
						<ToolHostProvider value={{ ...toolServices, prefs: scopedPrefs(prefsBridge.store, `app:${t.id}`) }}>
							<Sidebar peer={toolPeer} />
						</ToolHostProvider>
					),
				};
			}),
	[disabledBuiltins, toolServices, prefsBridge]);

	// ── App Builder callbacks ───────────────────────────────────────────────

	/** Tool tab → open/focus the tool's frame panel (extension host). */
	const onOpenTool = useCallback((toolId: string) => {
		sendMessage({ type: 'openTool', toolId });
	}, [sendMessage]);

	/** Strip tab selection → reveal an open window of the tool (create none),
	 *  and announce the activation on the shell event bus — single-pane
	 *  tools react by opening their pane; per-document tools ignore it.
	 *  (The FIRST selection also lazily mounts the tool's sidebar, which
	 *  treats mounting as its first activation — see the event's docs.) */
	const onFocusTool = useCallback((toolId: string) => {
		ConnectionManager.getInstance().emit('shell:toolSidebarActivated', { appId: toolId });
		sendMessage({ type: 'focusTool', toolId });
	}, [sendMessage]);

	/** Tool panel Remove row → unpin (extension host persists). */
	const onRemoveTool = useCallback((toolId: string) => {
		sendMessage({ type: 'removeTool', toolId });
	}, [sendMessage]);

	/** Dev Tools panel RESET → ext host re-fetches the app registry and
	 *  reloads every loaded tool (stale frame panels + this webview). */
	const onRefreshTools = useCallback(() => {
		sendMessage({ type: 'refreshTools' });
	}, [sendMessage]);

	/** Modules-list row → the tool's details page (README + Install/Remove). */
	const onShowTool = useCallback((toolId: string) => {
		sendMessage({ type: 'showToolReadme', toolId });
	}, [sendMessage]);

	/** Drag-reorder → apply optimistically, host persists to workspace state. */
	const onReorderTabs = useCallback((orderedIds: string[]) => {
		setTabOrder(orderedIds);
		sendMessage({ type: 'reorderTabs', order: orderedIds });
	}, [sendMessage]);

	/** Stable peer channel for one tool's sidebar mount (host-relayed).
	 *  ONE object per tool for the document's lifetime — mounted sidebars
	 *  memoize their bridges on its identity. */
	const getPeer = useCallback((appId: string) => {
		const cached = peersRef.current.get(appId);
		if (cached) return cached;
		const peer = {
			// Sidebar mounts post ONLY on user action (peer contract) — the host
			// summons the tool's frame panel for a message to a closed one.
			post: (message: unknown) => sendMessage({ type: 'devtool:peer', appId, payload: message }),
			subscribe: (cb: (message: unknown) => void) => {
				const subs = peerSubsRef.current.get(appId) ?? new Set<(msg: unknown) => void>();
				subs.add(cb);
				peerSubsRef.current.set(appId, subs);
				// Replay frame pushes that arrived before this first subscriber
				// (the host's retained replay lands at view:ready, long before
				// any mount loads — and lazily-activated mounts load later still).
				const pending = peerPendingRef.current.get(appId);
				if (pending) {
					peerPendingRef.current.delete(appId);
					for (const payload of pending) cb(payload);
				}
				return () => { subs.delete(cb); };
			},
		};
		peersRef.current.set(appId, peer);
		return peer;
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

	/** Tool tab body — the tool's devToolSidebar mounted natively, falling
	 *  back to the built-in card when the tool declares none. Tools never
	 *  activated render just the card: pinning N tools must not boot N
	 *  remotes (and their SDK connections) behind hidden tabs. */
	/** Stable documents API for one tool's sidebar mount — opens/closes the
	 *  tool's per-document editor panels (e.g. one per database connection)
	 *  through the extension host. One object per tool, like getPeer. */
	const documentsRef = useRef(new Map<string, { open: (docKey: string, title: string) => void; close: (docKey: string) => void }>());
	const getDocumentsApi = useCallback((appId: string) => {
		const cached = documentsRef.current.get(appId);
		if (cached) return cached;
		const api = {
			open: (docKey: string, title: string) => sendMessage({ type: 'openToolDocument', appId, docKey, title }),
			close: (docKey: string) => sendMessage({ type: 'closeToolDocument', appId, docKey }),
		};
		documentsRef.current.set(appId, api);
		return api;
	}, [sendMessage]);

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
				peer={getPeer(id)}
				documents={getDocumentsApi(id)}
				{...(activeDocKey !== undefined ? { activeDocKey } : {})}
				fallback={card}
			/>
		);
	}, [tools, devToolHost, activatedTools, activeToolDoc, getPeer, getDocumentsApi, onOpenTool, onRemoveTool]);

	// The TRUE previous mode, mirrored from state so externally applied
	// changes (modeUpdate, stripSeed) update it silently — only a chrome
	// selection below emits the deactivation for the tab it replaces.
	const prevSidebarModeRef = useRef<SidebarMode>(sidebarMode);
	useEffect(() => { prevSidebarModeRef.current = sidebarMode; }, [sidebarMode]);

	/** Mode strip selection — local state now, host persists via message. */
	const onSidebarModeChange = useCallback(
		(mode: SidebarMode) => {
			// A deselected tool tab gets its deactivation FIRST (before the
			// successor's activation from onFocusTool); re-selecting the same
			// tab deactivates nothing.
			const prev = prevSidebarModeRef.current;
			if (prev !== mode && prev.startsWith('tool:')) {
				ConnectionManager.getInstance().emit('shell:toolSidebarDeactivated', { appId: prev.slice('tool:'.length) });
			}
			// A user selection counts as the seed: an `update` composed before
			// the persist round trip completed must not revert it.
			sidebarModeSeededRef.current = true;
			setSidebarMode(mode);
			sendMessage({ type: 'setSidebarMode', mode });
		},
		[sendMessage]
	);

	// ── Footer popup menu items ─────────────────────────────────────────────
	//
	// Development and Deployment appear in the popup; clicking opens the
	// Settings page (dev or deploy section). Runs use the profile-assigned
	// development team, so no team selection exists here.
	// Account, Billing, Settings, Log out follow below.
	// ─────────────────────────────────────────────────────────────────────────

	/** Builds a mode display label like "Local" or "Cloud". */
	const modeLabel = (mode: string | null): string => {
		if (!mode) return 'Not configured';
		const labels: Record<string, string> = { local: 'Local', cloud: 'Cloud', docker: 'Docker', service: 'Service', onprem: 'Direct' };
		return labels[mode] ?? mode;
	};

	/** Builds a connection status string from state, mode, and optional progress. */
	const connectionStatusText = (state: string, mode: string | null, progressMessage?: string): string => {
		// Progress message takes priority (e.g. "Downloading 1.2.0: 45%", "Unpacking...")
		if (progressMessage) return progressMessage;
		const modeStr = modeLabel(mode);
		switch (state) {
			case 'connected':
				return `Connected (${modeStr})`;
			case 'connecting':
				return 'Connecting...';
			case 'downloading-engine':
				return 'Downloading engine...';
			case 'starting-engine':
				return 'Starting engine...';
			case 'stopping-engine':
				return 'Stopping engine...';
			case 'auth-failed':
				return 'Sign-in required';
			default:
				return 'Disconnected';
		}
	};

	// ── Footer menu items ───────────────────────────────────────────────────
	const anyConnected = connection.state === 'connected' || deployConnectionState === 'connected';

	const footerMenuItems: SidebarFooterMenuItem[] = useMemo(() => {
		const items: SidebarFooterMenuItem[] = [];

		// ── Development section ─────────────────────────────────────────────
		const devStatus = connectionStatusText(connection.state, developmentMode, devProgressMessage);
		const devLines = [devStatus, ...devProgressLog];
		items.push({
			id: 'dev-header',
			label: 'Development',
			header: true,
			statusText: devLines.join('\n'),
			statusState: connection.state === 'connected' ? 'connected' : connection.state === 'connecting' ? 'connecting' : 'disconnected',
			onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open', args: ['development'] }),
		});

		// ── Deployment section ──────────────────────────────────────────────
		if (deployTargetMode) {
			const deployStatus = connectionStatusText(deployConnectionState, deployTargetMode, deployProgressMessage);
			const deployLines = [deployStatus, ...deployProgressLog];
			items.push({
				id: 'deploy-header',
				label: 'Deployment',
				header: true,
				statusText: deployLines.join('\n'),
				statusState: deployConnectionState === 'connected' ? 'connected' : deployConnectionState === 'connecting' ? 'connecting' : 'disconnected',
				onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open', args: ['deployment'] }),
			});
		}

		// ── Account / Subscribe / Environment / Settings / Log out ──────────
		if (cloudConnected) {
			items.push({ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.account.open' }) });
		}

		// Subscribe CTA — only when cloud-signed-in but not subscribed
		if (cloudConnected && !subscribed) {
			items.push({ id: 'subscribe', label: 'Subscribe', icon: BxRocket, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.account.open', args: ['billing'] }) });
		}

		// Environment is visible whenever at least one connection is active,
		// regardless of whether the server is OSS or SaaS.
		if (anyConnected) {
			items.push({ id: 'environment', label: 'Variables', icon: BxLock, dividerBefore: !cloudConnected, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.environment.open' }) });
		}

		// Settings is always shown. Divider only when neither Account nor
		// Environment was shown above (i.e. not connected and not cloud).
		items.push({ id: 'settings', label: 'Settings', icon: BxCog, dividerBefore: !cloudConnected && !anyConnected, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open' }) });

		if (cloudConnected) {
			items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.cloud.logout' }) });
		}

		return items;
	}, [sendMessage, cloudConnected, connection.state, developmentMode, devProgressMessage, devProgressLog, deployConnectionState, deployTargetMode, deployProgressMessage, deployProgressLog, subscribed, anyConnected]);

	// ── Footer slot ─────────────────────────────────────────────────────────
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
