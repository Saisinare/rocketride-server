// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SIDEBAR WIRE VOCABULARY — extension host ↔ sidebar webview
// =============================================================================
//
// Both typed ends of the sidebar's postMessage traffic. The host's
// SidebarProvider switches over `WebviewToHost['type']`; the webview's
// useMessaging is parameterized on both unions — a renamed or mistyped
// message breaks the build instead of a flow.
//
// Namespaces per the wire-name convention: `sidebar:*` (this surface),
// `prefs:*` (the realm prefs bridge), `devtool:*` (tool peer relay),
// `svc:fs*` (the workspace-FS service RPC).
// =============================================================================

import type { SidebarMode, ToolTab } from 'shared/tools/core/chrome/types';
import type { DevToolHostInfo } from './DevToolSidebarMount';

/** The webview's requests to the extension host. */
export type SidebarWebviewToHost =
	| { type: 'view:ready' }
	| { type: 'sidebar:command'; command: string; args?: unknown[] }
	| { type: 'sidebar:openFile'; fsPath: string }
	| { type: 'sidebar:runPipeline'; fsPath: string; sourceId?: string }
	| { type: 'sidebar:stopPipeline'; projectId: string; sourceId: string }
	| { type: 'sidebar:openUnknownTask'; projectId: string; sourceId: string; displayName: string }
	| { type: 'sidebar:openApp'; appId: string }
	| { type: 'sidebar:setSidebarMode'; mode: SidebarMode }
	| { type: 'sidebar:openTool'; toolId: string }
	| { type: 'sidebar:focusTool'; toolId: string }
	| { type: 'sidebar:refreshTools' }
	| { type: 'sidebar:removeTool'; toolId: string }
	| { type: 'sidebar:showToolReadme'; toolId: string }
	| { type: 'sidebar:reorderTabs'; order: string[] }
	| { type: 'sidebar:setDisabledBuiltins'; ids: string[] }
	| { type: 'prefs:set'; key: string; value: unknown; scope: 'workspace' | 'global' }
	| { type: 'sidebar:openToolDocument'; appId: string; docKey: string; title: string }
	| { type: 'sidebar:closeToolDocument'; appId: string; docKey: string }
	| { type: 'svc:fs'; id: number; method: 'findFiles'; include: string; exclude?: string }
	| { type: 'svc:fs'; id: number; method: 'workspaceRoots' }
	| { type: 'svc:fs'; id: number; method: 'readText'; path: string }
	| { type: 'svc:fs'; id: number; method: 'readBase64'; path: string; maxBytes: number }
	| { type: 'svc:fs:watch'; id: number; globs: string[] }
	| { type: 'svc:fs:unwatch'; id: number };

/** The connection/auth/strip half of a full host update. */
export interface SidebarUpdateData {
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
}

/** The extension host's pushes to the webview. */
export type SidebarHostToWebview =
	| { type: 'sidebar:update'; data: SidebarUpdateData }
	// The network-derived half of a full update: identity, pinned tool rows,
	// the dev-tool catalog, and the devToolSidebar connection facts — posted
	// separately so these slow lookups can never delay or drop the sync half.
	| { type: 'sidebar:extrasUpdate'; userName?: string; userEmail?: string; tools: ToolTab[]; availableTools: ToolTab[]; devToolHost: DevToolHostInfo | null }
	| { type: 'sidebar:toolsUpdate'; tools: ToolTab[]; available: ToolTab[] }
	| { type: 'sidebar:stripSeed'; tools: ToolTab[]; tabOrder: string[]; sidebarMode: SidebarMode; disabledBuiltins?: string[] }
	| { type: 'prefs:init'; values: Record<string, unknown> }
	| { type: 'devtool:activeDoc'; appId: string | null; docKey: string | null }
	| { type: 'svc:fs:result'; id: number; ok: boolean; result?: unknown; error?: string }
	| { type: 'svc:fs:event'; id: number; path: string }
	| { type: 'sidebar:modeUpdate'; mode: SidebarMode }
	| { type: 'sidebar:statusUpdate'; projectId: string; sourceId: string; errors: string[]; warnings: string[] };
