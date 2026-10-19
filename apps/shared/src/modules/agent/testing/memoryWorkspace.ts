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
// MEMORY WORKSPACE — an in-memory IWorkspaceFileSystem for agent tests
// =============================================================================

/**
 * A fake workspace that keeps text files in a Map. It satisfies the full
 * IWorkspaceFileSystem view contract so tools and checks run against it
 * unchanged, and it records every mutation in `log` for a test to assert on.
 * The cache and subscription methods do nothing, because an in-memory map has
 * no cache to keep warm.
 */

import type { IWorkspaceFileSystem, VfsEntry } from '../../vfs/vfsTypes';

// =============================================================================
// TYPES
// =============================================================================

/** One recorded mutation. For a rename, `path` is the old path. */
interface MemoryWorkspaceLogEntry {
	/** The operation. */
	op: 'write' | 'rename' | 'delete' | 'mkdir';
	/** The path acted on. */
	path: string;
}

/** The workspace view plus the handles a test uses to set up and inspect it. */
export interface MemoryWorkspace extends IWorkspaceFileSystem {
	/** Every file, path to content. Tests may edit it directly. */
	files: Map<string, string>;
	/** Every write, rename, delete and mkdir, in order. */
	log: MemoryWorkspaceLogEntry[];
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/** The workspace class; callers get it through createMemoryWorkspace(). */
class InMemoryWorkspace implements MemoryWorkspace {
	readonly files: Map<string, string>;
	readonly log: MemoryWorkspaceLogEntry[] = [];
	/** Folders made with mkdir(); folders that hold files are implied by their paths. */
	private readonly dirs = new Set<string>();
	private readonly dirty: Set<string>;

	/**
	 * @param files - Starting files, path to content.
	 * @param dirty - Paths that start out dirty.
	 */
	constructor(files: Record<string, string>, dirty: string[]) {
		this.files = new Map(Object.entries(files));
		this.dirty = new Set(dirty);
	}

	// ---- reads ----

	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const base = dir.replace(/\/+$/, '');
		if (base && !this.isDir(base)) throw new Error(`No such directory: ${dir}`);
		const prefix = base ? `${base}/` : '';
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of [...this.files.keys(), ...this.dirs]) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			const isFile = slash < 0 && this.files.has(path);
			names.set(slash < 0 ? rest : rest.slice(0, slash), isFile ? 'file' : 'dir');
		}
		return [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, type]) => ({ name, type }));
	}

	async read(path: string): Promise<unknown> {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`No such file: ${path}`);
		return content;
	}

	async readMany(paths: string[]): Promise<Map<string, unknown>> {
		const out = new Map<string, unknown>();
		for (const path of paths) {
			const content = this.files.get(path);
			if (content !== undefined) out.set(path, content);
		}
		return out;
	}

	async stat(path: string): Promise<'file' | 'dir' | null> {
		return this.entryType(path);
	}

	listEntries(): VfsEntry[] {
		const byPath = new Map<string, 'file' | 'dir'>();
		for (const path of [...this.files.keys(), ...this.dirs]) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) byPath.set(parts.slice(0, i).join('/'), 'dir');
		}
		for (const dir of this.dirs) byPath.set(dir, 'dir');
		for (const file of this.files.keys()) byPath.set(file, 'file');
		return [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, type]) => ({ path, type }));
	}

	entryType(path: string): 'file' | 'dir' | null {
		if (this.files.has(path)) return 'file';
		return this.isDir(path) ? 'dir' : null;
	}

	cachedContent(path: string): unknown {
		return this.files.get(path);
	}

	async peekBase(path: string): Promise<unknown> {
		return this.read(path);
	}

	// ---- mutations ----

	async write(path: string, content: unknown): Promise<void> {
		if (typeof content !== 'string') throw new Error(`The memory workspace holds text only: ${path}`);
		this.files.set(path, content);
		this.record('write', path);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		if (this.entryType(oldPath) === null) throw new Error(`No such file or directory: ${oldPath}`);
		const move = (path: string) => (path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`);
		for (const path of this.under(oldPath, this.files.keys())) {
			this.files.set(move(path), this.files.get(path) as string);
			this.files.delete(path);
		}
		for (const path of this.under(oldPath, this.dirs)) {
			this.dirs.delete(path);
			this.dirs.add(move(path));
		}
		this.record('rename', oldPath);
	}

	async delete(path: string): Promise<void> {
		if (this.entryType(path) === null) throw new Error(`No such file or directory: ${path}`);
		for (const file of this.under(path, this.files.keys())) this.files.delete(file);
		for (const dir of this.under(path, this.dirs)) this.dirs.delete(dir);
		this.record('delete', path);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
		this.record('mkdir', path);
	}

	// ---- dirty state ----

	isDirty(path: string): boolean {
		return this.dirty.has(path);
	}

	dirtyPaths(): Set<string> {
		return new Set(this.dirty);
	}

	// ---- cache and subscription: nothing to keep warm or announce ----

	async refresh(): Promise<void> {}
	upsert(): void {}
	prime(): void {}
	invalidate(): void {}
	registerOverlay(): () => void {
		return () => {};
	}
	subscribe(): () => void {
		return () => {};
	}
	notify(): void {}

	// ---- helpers ----

	/** Whether a path is a folder: made by mkdir(), or the parent of something stored. */
	private isDir(path: string): boolean {
		if (path === '') return true;
		const prefix = `${path}/`;
		return this.dirs.has(path) || [...this.files.keys(), ...this.dirs].some((p) => p.startsWith(prefix));
	}

	/** The paths equal to `root` or inside it, collected up front so callers may mutate the source. */
	private under(root: string, paths: Iterable<string>): string[] {
		const prefix = `${root}/`;
		return [...paths].filter((p) => p === root || p.startsWith(prefix));
	}

	/** Appends a log entry. */
	private record(op: MemoryWorkspaceLogEntry['op'], path: string): void {
		this.log.push({ op, path });
	}
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds an in-memory workspace.
 *
 * @param files - Starting files, path to content.
 * @param opts - `dirty` lists paths that start out with unsaved editor changes.
 * @returns The workspace.
 */
export function createMemoryWorkspace(files: Record<string, string>, opts?: { dirty?: string[] }): MemoryWorkspace {
	return new InMemoryWorkspace(files, opts?.dirty ?? []);
}
