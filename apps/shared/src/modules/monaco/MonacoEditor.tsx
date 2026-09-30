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
// MONACO EDITOR — the shared editor component (bundled Monaco, rr theme)
// =============================================================================

/**
 * The platform's one Monaco editor component. Two binding modes:
 *
 *  - `model`  — the caller owns a live ITextModel (the App Builder's Code
 *    pane; models carry per-app URIs the TS worker compiles against).
 *  - `value`  — controlled text + language (the Explorer viewer, the SQL
 *    editor); an internal model is created and synced.
 *
 * Loading is lazy (loadMonaco — a chunk of the consuming remote), the rr
 * token theme is applied and follows app theme flips, and the editor
 * disposes cleanly on unmount.
 */

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { loadMonaco } from './loader';
import type { Monaco } from './loader';
import { THEME_NAME, defineRrTheme, useThemeVersion } from './theme';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link MonacoEditor} component. */
export interface IMonacoEditorProps {
	/** Caller-owned model (wins over value/language). */
	model?: MonacoEditorNs.ITextModel | null;
	/** Controlled text (value mode). */
	value?: string;
	/** Language id for value mode. */
	language?: string;
	/** Change callback (both modes). */
	onChange?: (value: string) => void;
	/** Runs before the editor is created (extra setup on the namespace). */
	beforeMount?: (monaco: Monaco) => void;
	/** Runs once after the editor is created. */
	onMount?: (editorInstance: MonacoEditorNs.IStandaloneCodeEditor, monaco: Monaco) => void;
	/** Editor construction options (merged over the platform defaults). */
	options?: MonacoEditorNs.IStandaloneEditorConstructionOptions;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		overflow: 'hidden',
	},
};

/** The platform's default editor options (mirrors the Explorer viewer's). */
const DEFAULT_OPTIONS: MonacoEditorNs.IStandaloneEditorConstructionOptions = {
	fontSize: 13,
	lineHeight: 20,
	tabSize: 4,
	fontFamily: 'var(--rr-font-mono, "Cascadia Code", Consolas, "Courier New", monospace)',
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	automaticLayout: true,
	wordWrap: 'off',
	renderLineHighlight: 'line',
	padding: { top: 8 },
	// Render suggest/hover/parameter-hint widgets position:fixed so ancestor
	// overflow:hidden containers (panels, tabs, webview layout) cannot clip them.
	fixedOverflowWidgets: true,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the shared Monaco editor (see the module doc).
 *
 * @param props - See {@link IMonacoEditorProps}.
 */
export const MonacoEditor: React.FC<IMonacoEditorProps> = ({ model, value, language, onChange, beforeMount, onMount, options }) => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
	const monacoRef = useRef<Monaco | null>(null);
	/** The internally owned model (value mode only). */
	const ownedModelRef = useRef<MonacoEditorNs.ITextModel | null>(null);
	/** Suppresses onChange echoes while the component itself sets text. */
	const silentRef = useRef(false);
	const themeVersion = useThemeVersion();

	// Latest props for the async create step (create runs once).
	const propsRef = useRef({ model, value, language, onChange, beforeMount, onMount, options });
	propsRef.current = { model, value, language, onChange, beforeMount, onMount, options };

	// ── Create once ──────────────────────────────────────────────────────
	useEffect(() => {
		let disposed = false;
		void loadMonaco().then((monaco) => {
			if (disposed || !containerRef.current) return;
			monacoRef.current = monaco;
			const p = propsRef.current;
			// step: theme + caller setup before the first paint
			defineRrTheme(monaco);
			p.beforeMount?.(monaco);
			// step: pick the binding — caller model, or an owned value model
			let boundModel = p.model ?? null;
			if (!boundModel) {
				boundModel = monaco.editor.createModel(p.value ?? '', p.language ?? 'plaintext');
				ownedModelRef.current = boundModel;
			}
			const editorInstance = monaco.editor.create(containerRef.current, {
				...DEFAULT_OPTIONS,
				...p.options,
				model: boundModel,
				theme: THEME_NAME,
			});
			editorRef.current = editorInstance;
			// step: change fan-out (skipping our own silent writes)
			editorInstance.onDidChangeModelContent(() => {
				if (silentRef.current) return;
				propsRef.current.onChange?.(editorInstance.getValue());
			});
			p.onMount?.(editorInstance, monaco);
		});
		return () => {
			disposed = true;
			editorRef.current?.dispose();
			editorRef.current = null;
			ownedModelRef.current?.dispose();
			ownedModelRef.current = null;
		};
	}, []);

	// ── Model swaps (model mode) ─────────────────────────────────────────
	useEffect(() => {
		const editorInstance = editorRef.current;
		if (!editorInstance || !model) return;
		if (editorInstance.getModel() !== model) editorInstance.setModel(model);
	}, [model]);

	// ── External value sync (value mode) ─────────────────────────────────
	useEffect(() => {
		const editorInstance = editorRef.current;
		if (!editorInstance || model || value === undefined) return;
		if (editorInstance.getValue() !== value) {
			silentRef.current = true;
			editorInstance.setValue(value);
			silentRef.current = false;
		}
	}, [value, model]);

	// ── Language sync (value mode) ───────────────────────────────────────
	useEffect(() => {
		const monaco = monacoRef.current;
		const owned = ownedModelRef.current;
		if (!monaco || !owned || !language) return;
		monaco.editor.setModelLanguage(owned, language);
	}, [language]);

	// ── Theme flips ──────────────────────────────────────────────────────
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco) return;
		defineRrTheme(monaco);
		monaco.editor.setTheme(THEME_NAME);
	}, [themeVersion]);

	return <div ref={containerRef} style={styles.container} />;
};
