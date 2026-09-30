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
// APP FILES — the working-tree VFS backend + bulk text load
// =============================================================================

/**
 * File access for one `.appdev/<folder>/` working copy: the client-backed
 * {@link IVirtualFileSystem} the session's CachedVfs wraps, plus a batched
 * full-tree text load (`fsReadMany` — one round trip per 256 files instead
 * of 3+ per file). The design loop keeps the whole text tree
 * memory-resident (the TS language host is synchronous), so open-an-app ==
 * load-everything; binary assets are listed by the VFS but only read on
 * demand.
 */

import type { IVirtualFileSystem, RocketRideClient } from 'shell';
import { appPath, emitFsChange } from './appStore';

/** File extensions the design loop loads as text into Monaco models. */
const TEXT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'json', 'css', 'scss', 'less', 'md', 'svg', 'html', 'txt', 'rrapp', 'gitignore', 'yaml', 'yml']);

/** Store subtrees the loop never loads (derived outputs, never user truth). */
export const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git'];

/**
 * Whether a file participates in the design loop as text.
 *
 * @param name - The leaf file name (or any path — the leaf is derived).
 */
export function isTextFile(name: string): boolean {
	const leaf = name.split('/').pop() ?? name;
	const ext = leaf.split('.').pop()?.toLowerCase() ?? '';
	return TEXT_EXTENSIONS.has(ext) || leaf.startsWith('.');
}

/**
 * Builds the client-backed VFS for one app folder — the backend the
 * session's CachedVfs decorates. Reads return strings for text files and
 * bytes (Uint8Array) for everything else; writes are text-only (binary
 * assets arrive via scaffold/packaging, never through the design loop) and
 * announce themselves on the notification bus.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param origin - The writer's identity stamped on write notifications
 *                 (a dev-session id) — listeners skip their own echo.
 */
export function createAppVfsBackend(client: RocketRideClient, folder: string, origin: string): IVirtualFileSystem {
	return {
		list: async (dir) => {
			const result = await client.fsListDir(dir ? appPath(folder, dir) : appPath(folder));
			return (result.entries ?? []).map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' as const : 'file' as const }));
		},
		read: async (path) => {
			if (isTextFile(path)) return client.fsReadString(appPath(folder, path));
			const [entry] = await client.fsReadMany([appPath(folder, path)]);
			if (!entry?.ok || !entry.data) throw new Error(`Could not read ${path}`);
			return entry.data;
		},
		write: async (path, content) => {
			if (typeof content !== 'string') throw new Error('The design loop writes text files only.');
			const uri = appPath(folder, path);
			await client.fsWriteString(uri, content);
			emitFsChange(uri, origin);
		},
		rename: async (oldPath, newPath) => {
			await client.fsRename(appPath(folder, oldPath), appPath(folder, newPath));
			emitFsChange(appPath(folder, newPath), origin);
		},
		delete: async (path) => {
			const uri = appPath(folder, path);
			// step: directories go through the recursive rmdir verb
			const stat = await client.fsStat(uri);
			if (stat.type === 'dir') await client.fsRmdir(uri, true);
			else await client.fsDelete(uri);
			emitFsChange(uri, origin);
		},
		mkdir: async (path) => {
			await client.fsMkdir(appPath(folder, path));
		},
	};
}

/**
 * Loads the whole working tree in fsReadMany batches.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param paths - The relative text-file paths to load (from the VFS inventory).
 * @returns path -> file text (unreadable entries are omitted).
 */
export async function loadAppFiles(client: RocketRideClient, folder: string, paths: string[]): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const decoder = new TextDecoder();
	// step: batch in fsReadMany's 256-path chunks
	for (let i = 0; i < paths.length; i += 256) {
		const chunk = paths.slice(i, i + 256);
		const results = await client.fsReadMany(chunk.map((p) => appPath(folder, p)));
		results.forEach((entry, idx) => {
			if (entry.ok && entry.data) files.set(chunk[idx], decoder.decode(entry.data));
		});
	}
	return files;
}
