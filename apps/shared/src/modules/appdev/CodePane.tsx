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
// CODE PANE — stock Explorer over the working tree + Monaco editor
// =============================================================================

/**
 * The CODE view's surface: the stock shell {@link Explorer} over the app's
 * CachedVfs inventory (EVERY file — binary assets included) beside the
 * shared Monaco editor bound to the selected file's model. The pane is
 * presentational — the VFS owns the tree, the content cache, and the dirty
 * aggregate (the Explorer's modified dots); the MODEL STORE (Monaco models,
 * saves) is owned by the host's dev session and handed in through the
 * {@link AppCodeStore} seam.
 *
 * Selection semantics: a text file binds its Monaco model; a file with no
 * model is a binary asset and renders the read-only preview pane (image
 * types inline via a blob URL, everything else as name + size).
 *
 * Save lifecycle is the pane's own (the App Builder document is a static
 * doc — the shell's dirty/save hooks never fire): dirty dots per file,
 * Ctrl+S saves the active file.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { Explorer } from 'shell';
import type { CachedVfs, ExplorerConfig, ExplorerEntry } from 'shell';
import { MonacoEditor } from '../monaco';

// =============================================================================
// TYPES
// =============================================================================

/**
 * The model store a host's dev session supplies: every text file of the
 * working copy as a live Monaco model, plus dirty tracking and saves.
 */
export interface AppCodeStore {
	/** Ordered project-relative file paths (POSIX). */
	listFiles(): string[];
	/** The live model for a path (null while loading/unknown). */
	getModel(path: string): MonacoEditorNs.ITextModel | null;
	/** Whether the path has unsaved edits. */
	isDirty(path: string): boolean;
	/** Persist one file to the store VFS. */
	save(path: string): Promise<void>;
	/** WHY loading failed (null = fine) — renders instead of the tree. */
	getLoadError?(): string | null;
	/** Change notifications (files list, dirty set). Returns unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/** Props for the {@link CodePane} component. */
export interface ICodePaneProps {
	/** The host's model store. */
	store: AppCodeStore;
	/** The working tree's caching VFS (inventory + dirty + content). */
	vfs: CachedVfs;
}

// =============================================================================
// CONFIG
// =============================================================================

/** Explorer configuration for the working-tree file browser. */
const EXPLORER_CONFIG: ExplorerConfig = {
	title: 'Files',
	emptyMessage: 'No files',
	allowFolders: true,
};

/** Image extensions the binary preview renders inline, with their MIME. */
const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	ico: 'image/x-icon',
	bmp: 'image/bmp',
	avif: 'image/avif',
};

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	root: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		minHeight: 0,
		minWidth: 0,
		background: 'var(--rr-bg-default)',
	},
	// The Explorer column — the stock component fills it (its container is
	// flex:1) and scrolls its own tree list.
	tree: {
		width: 240,
		flex: 'none',
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
		borderRight: '1px solid var(--rr-border)',
		paddingTop: 4,
	},
	editorWrap: {
		flex: 1,
		minWidth: 0,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	},
	empty: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	},
	// Binary asset preview — centered card with name, size, and (for image
	// types) the rendered asset.
	binaryWrap: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 10,
		padding: 24,
		overflow: 'auto',
	},
	binaryName: {
		fontSize: 13,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		color: 'var(--rr-text-primary)',
	},
	binaryMeta: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	},
	binaryImg: {
		maxWidth: '100%',
		maxHeight: '70%',
		objectFit: 'contain',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		background: 'var(--rr-bg-widget)',
	},
};

// =============================================================================
// BINARY PREVIEW
// =============================================================================

/**
 * Read-only preview for a file with no Monaco model (a binary asset): image
 * types render inline via a blob URL, everything else shows name + size.
 *
 * @param props.vfs - The working tree's VFS (byte source).
 * @param props.path - The asset's project-relative path.
 */
const BinaryPreview: React.FC<{ vfs: CachedVfs; path: string }> = ({ vfs, path }) => {
	const [size, setSize] = useState<number | null>(null);
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [error, setError] = useState('');

	useEffect(() => {
		let cancelled = false;
		let url: string | null = null;
		setSize(null);
		setImageUrl(null);
		setError('');
		void vfs.read(path)
			.then((content) => {
				if (cancelled) return;
				// step: normalize the VFS content to bytes for size + preview
				const bytes = content instanceof Uint8Array ? content
					: content instanceof ArrayBuffer ? new Uint8Array(content)
					: typeof content === 'string' ? new TextEncoder().encode(content)
					: null;
				if (!bytes) { setError('Unreadable content.'); return; }
				setSize(bytes.byteLength);
				const ext = path.split('.').pop()?.toLowerCase() ?? '';
				const mime = IMAGE_MIME[ext];
				if (mime) {
					url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
					setImageUrl(url);
				}
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
			if (url) URL.revokeObjectURL(url);
		};
	}, [vfs, path]);

	const name = path.split('/').pop() ?? path;
	return (
		<div style={styles.binaryWrap}>
			{imageUrl && <img src={imageUrl} alt={name} style={styles.binaryImg} />}
			<span style={styles.binaryName}>{name}</span>
			<span style={styles.binaryMeta}>
				{error ? `Could not read this file: ${error}`
					: size === null ? 'Loading…'
					: `Binary asset · ${size.toLocaleString()} bytes${imageUrl ? '' : ' · no inline preview for this type'}`}
			</span>
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the Code pane: the stock Explorer beside the editor/preview for
 * the selection.
 *
 * @param props - See {@link ICodePaneProps}.
 */
export const CodePane: React.FC<ICodePaneProps> = ({ store, vfs }) => {
	// step: re-render on VFS changes — the session's notifyStore announces
	// model/dirty flips there too, so ONE subscription covers everything
	const [seq, setSeq] = useState(0);
	useEffect(() => vfs.subscribe(() => setSeq((n) => n + 1)), [vfs]);

	// The full inventory (files AND dirs — empty folders stay visible).
	const entries = useMemo<ExplorerEntry[]>(
		() => vfs.listEntries().map((e) => ({ path: e.path, type: e.type })),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- seq is the VFS change tick
		[vfs, seq],
	);
	const modifiedPaths = useMemo(
		() => vfs.dirtyPaths(),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- seq is the VFS change tick
		[vfs, seq],
	);

	const files = store.listFiles();
	const [active, setActive] = useState<string>('');
	// step: default the selection to the app root component when it exists
	useEffect(() => {
		if (active && vfs.entryType(active) === 'file') return;
		const preferred = files.find((f) => f === 'src/App.tsx') ?? files[0] ?? '';
		setActive(preferred);
	}, [files, active, vfs]);

	// The Ctrl+S command binds once at editor mount but must save whatever
	// file is active WHEN PRESSED — route through a ref, not the closure.
	const activeRef = useRef(active);
	activeRef.current = active;

	/** Saves the active file (bound to Ctrl+S inside the editor). */
	const saveActive = useCallback(() => {
		if (activeRef.current) void store.save(activeRef.current);
	}, [store]);

	/** Opens a file row: files select; the Explorer handles dirs itself. */
	const openFile = useCallback((path: string) => {
		if (vfs.entryType(path) !== 'dir') setActive(path);
	}, [vfs]);

	/** Re-walks the working tree on the Explorer's refresh button. */
	const refresh = useCallback(() => { void vfs.refresh(); }, [vfs]);

	const model = active ? store.getModel(active) : null;

	// step: a failed load renders its reason — never an eternal spinner
	const loadError = store.getLoadError?.();
	if (loadError && files.length === 0) {
		return (
			<div style={styles.root}>
				<div style={styles.empty}>Could not load the app&rsquo;s files: {loadError}</div>
			</div>
		);
	}

	return (
		<div style={styles.root}>
			{/* Working-tree browser — the stock Explorer over the VFS
			    inventory, with the dirty set as modified dots. Display-only:
			    no onFileManage until the session grows store-synced
			    rename/delete verbs. */}
			<div style={styles.tree}>
				<Explorer
					vfs={vfs}
					config={EXPLORER_CONFIG}
					entries={entries}
					isConnected
					activeFilePath={active}
					modifiedPaths={modifiedPaths}
					onOpenFile={openFile}
					onRefresh={refresh}
				/>
			</div>

			{/* Editor bound to the selected file's model; binary assets render
			    the read-only preview instead. */}
			<div style={styles.editorWrap}>
				{model ? (
					<MonacoEditor
						model={model}
						onMount={(editorInstance, monaco) => {
							// Ctrl+S saves through the store — the surrounding
							// document is static, so no shell save exists to ride.
							editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
						}}
					/>
				) : active && vfs.entryType(active) === 'file' ? (
					<BinaryPreview vfs={vfs} path={active} />
				) : (
					<div style={styles.empty}>{files.length === 0 ? 'Loading files…' : 'Select a file to edit.'}</div>
				)}
			</div>
		</div>
	);
};
