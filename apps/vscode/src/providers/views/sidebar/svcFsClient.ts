// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SVC:FS CLIENT — the webview end of the host's workspace-FS service
// =============================================================================
//
// The ToolWorkspaceFs the shared tool code runs against in this host:
// requests ride the sidebar message channel to the extension host's generic
// service (request/response correlated by id); watch events fan out to the
// registered callbacks. The component wires onResult/onEvent into its
// message switch.
// =============================================================================

import type { ToolWorkspaceFs } from 'shell';
import type { SidebarWebviewToHost } from './messages';

/** The svc:fs subset of the outgoing vocabulary. */
type SvcFsRequest = Extract<SidebarWebviewToHost, { type: 'svc:fs' | 'svc:fs:watch' | 'svc:fs:unwatch' }>;

/** What the client exposes to the component. */
export interface SvcFsClient {
	/** The capability handed to the tools (ToolHostServices.workspaceFs). */
	workspaceFs: ToolWorkspaceFs;
	/** Routes one svc:fs:result message to its pending request. */
	onResult(msg: { id: number; ok: boolean; result?: unknown; error?: string }): void;
	/** Routes one svc:fs:event message to its watch callback. */
	onEvent(msg: { id: number; path: string }): void;
}

/**
 * Creates the webview-side workspace-FS client.
 *
 * @param send - Sends one svc:fs request to the extension host.
 * @returns The client.
 */
export function createSvcFsClient(send: (message: SvcFsRequest) => void): SvcFsClient {
	let seq = 0;
	const pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const watchers = new Map<number, (path: string) => void>();

	const request = (message: SvcFsRequest & { id: number }): Promise<unknown> =>
		new Promise((resolve, reject) => {
			pendingRequests.set(message.id, { resolve, reject });
			send(message);
		});

	return {
		workspaceFs: {
			findFiles: (include, exclude) =>
				request({ type: 'svc:fs', id: ++seq, method: 'findFiles', include, ...(exclude !== undefined ? { exclude } : {}) }) as Promise<string[]>,
			workspaceRoots: () =>
				request({ type: 'svc:fs', id: ++seq, method: 'workspaceRoots' }) as Promise<string[]>,
			readTextFile: (path) =>
				request({ type: 'svc:fs', id: ++seq, method: 'readText', path }) as Promise<string>,
			readFileBase64: (path, maxBytes) =>
				request({ type: 'svc:fs', id: ++seq, method: 'readBase64', path, maxBytes }) as Promise<string | null>,
			watch: (globs, onEvent) => {
				const id = ++seq;
				watchers.set(id, onEvent);
				send({ type: 'svc:fs:watch', id, globs });
				return () => {
					watchers.delete(id);
					send({ type: 'svc:fs:unwatch', id });
				};
			},
		},

		onResult(msg) {
			const pending = pendingRequests.get(msg.id);
			if (!pending) return;
			pendingRequests.delete(msg.id);
			if (msg.ok) pending.resolve(msg.result);
			else pending.reject(new Error(msg.error ?? 'workspace-fs service error'));
		},

		onEvent(msg) {
			watchers.get(msg.id)?.(msg.path);
		},
	};
}
