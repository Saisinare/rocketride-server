// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER FS — where the frame's store access actually goes
// =============================================================================
//
// The viewer surface reaches the server store through this ONE seam instead
// of holding a RocketRide client. Two implementations:
//
//   LOCAL  (createLocalExplorerFs)  — wraps the shell client directly; used
//          by the full app, whose realm legitimately owns a connection.
//   REMOTE (createRemoteExplorerFs) — routes every call over controller(...)
//          ops to the tool's sidebar controller (the file tree's realm,
//          which keeps its own client). Used by dev-tool document frames:
//          frames hold NO client. Presigned-URL fetches stay in the frame —
//          they are plain HTTP, no engine connection involved.
// =============================================================================

import type { RocketRideClient, ToolControllerFn } from 'shell';
import type { ExplorerDirEntry, ExplorerOps, ExplorerStat } from './ops';

/** The store surface the explorer frame uses — never a client. */
export interface IExplorerFs {
	/** Whether the store is reachable (gates mounting and hex fallback). */
	ready: boolean;
	/** Directory listing (name + type per entry). */
	list(dir: string): Promise<ExplorerDirEntry[]>;
	/** Read a text file. */
	readString(path: string): Promise<string>;
	/** Presigned URL for streaming/fetching the file's bytes. */
	getUrl(path: string): Promise<string>;
	/** Write a text file. */
	writeString(path: string, content: string): Promise<void>;
	/** Rename/move. */
	rename(oldPath: string, newPath: string): Promise<void>;
	/** File metadata (type, size). */
	stat(path: string): Promise<ExplorerStat>;
	/** Delete a file, or a directory recursively. */
	remove(path: string): Promise<void>;
	/** Create a directory. */
	mkdir(path: string): Promise<void>;
}

/** The slice streaming viewers (hex/video/audio) need. */
export type ExplorerViewerFs = Pick<IExplorerFs, 'getUrl' | 'stat'>;

/**
 * The client-backed store surface (the full app's realm).
 *
 * @param client - The realm's client, or null while disconnected.
 * @param isConnected - The shell's connection flag.
 * @returns The fs (rebuild on client/connection change).
 */
export function createLocalExplorerFs(client: RocketRideClient | null, isConnected: boolean): IExplorerFs {
	const need = (): RocketRideClient => {
		if (!client || !isConnected) throw new Error('Not connected to a server.');
		return client;
	};
	return {
		ready: !!client && isConnected,
		list: async (dir) => {
			const result = await need().fsListDir(dir);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (result.entries ?? []).map((e: any) => ({ name: e.name as string, type: e.type === 'dir' ? 'dir' as const : 'file' as const }));
		},
		readString: (path) => need().fsReadString(path),
		getUrl: (path) => need().fsGetUrl(path),
		writeString: async (path, content) => { await need().fsWriteString(path, content); },
		rename: async (oldPath, newPath) => { await need().fsRename(oldPath, newPath); },
		stat: async (path) => {
			const stat = await need().fsStat(path);
			return { ...(stat.type !== undefined ? { type: stat.type } : {}), ...(stat.size !== undefined ? { size: stat.size } : {}) };
		},
		remove: async (path) => {
			const live = need();
			const stat = await live.fsStat(path);
			if (stat.type === 'dir') await live.fsRmdir(path, true);
			else await live.fsDelete(path);
		},
		mkdir: async (path) => { await need().fsMkdir(path); },
	};
}

/**
 * The controller-backed store surface (dev-tool document frames): every
 * call crosses the tool channel and executes on the controller's single
 * engine connection.
 *
 * @param call - The frame's controller function (createToolController(peer)).
 * @param ready - The controller realm's server reachability (`host:connection`).
 * @returns The fs (rebuild when `ready` changes).
 */
export function createRemoteExplorerFs(call: ToolControllerFn<ExplorerOps>, ready: boolean): IExplorerFs {
	return {
		ready,
		list: (dir) => call('explorer.listDir', { dir }),
		readString: (path) => call('explorer.readString', { path }),
		getUrl: (path) => call('explorer.getUrl', { path }),
		writeString: (path, content) => call('explorer.writeString', { path, content }),
		rename: (oldPath, newPath) => call('explorer.rename', { oldPath, newPath }),
		stat: (path) => call('explorer.stat', { path }),
		remove: (path) => call('explorer.remove', { path }),
		mkdir: (path) => call('explorer.mkdir', { path }),
	};
}
