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
// APP TYPES — type errors read from Monaco's markers
// =============================================================================

/**
 * The type half of an app check. An open app's dev session loads every file of
 * the app as a Monaco model at `file:///${appId}/${relPath}`, and Monaco's
 * TypeScript service keeps its type errors for each model as markers. This
 * reads those markers, so it costs no build and no extra compiler.
 *
 * What counts as what, because a check that wrongly passes lets the agent claim
 * the app is typed and one that cannot pass leaves it stuck:
 *
 * - Only markers with owner `typescript` and severity Error count. Warnings
 *   are not failures, and the `rr-appdev` markers are link errors a build sets,
 *   which the build evidence reports.
 * - An app with no models (it is not open) is `not_run`: no models means no
 *   markers, and that is not the same as no errors.
 * - A file with no model is named in the output and the summary counts it, so
 *   a clean result never hides a file nobody looked at.
 *
 * Monaco validates a model some time after it changes (a 500 ms debounce, then
 * a round trip to the TypeScript worker, with no "done" signal), so
 * `settleMarkers` first waits for the worker to be up and hold the models, then
 * for the markers to go quiet, before a caller reads them. A model with no
 * markers yet looks exactly like a model with no errors; reading too early is
 * the false pass this file exists to avoid.
 *
 * `monacoMarkerSource` is the only browser-only code here; everything else runs
 * against a `MarkerSource`, so tests pass a fake and never load Monaco.
 */

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';
import { clip, messageOf } from '../rocketride/common';
import { readApps } from '../rocketride/inventory';
import type { AppEntry } from '../rocketride/inventory';
import type { CheckEvidence } from './check';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The owner of Monaco's TypeScript diagnostics. */
const TYPESCRIPT_OWNER = 'typescript';

/** Monaco's `MarkerSeverity.Error`, kept here so the tests need no Monaco. */
const SEVERITY_ERROR = 8;

/**
 * How long the markers must be quiet before they count as settled, in milliseconds.
 * Longer than Monaco's 500 ms validation debounce, so a quiet window that opens
 * just after an edit still outlasts the validation that edit starts.
 */
const DEFAULT_QUIET_MS = 1500;

/** The longest `settleMarkers` waits, in milliseconds, however often the markers change or the worker is slow. */
const DEFAULT_MAX_MS = 10_000;

/** The step name in the evidence. */
const STEP = 'types';

/** What the step does, as a short phrase. */
const RAN = "read the TypeScript errors Monaco keeps for the app's open files";

/** The summary for an app that has no models. */
const NOT_OPEN_SUMMARY = 'types not checked until the app is open or deployed';

/** What the output says for an app that has no models. */
const NOT_OPEN_OUTPUT = "None of the app's TypeScript files are loaded in the editor, so there are no TypeScript errors to read. Open the app, or deploy it, to check its types.";

// =============================================================================
// TYPES
// =============================================================================

/** One diagnostic Monaco holds for a model. */
export interface MarkerInfo {
	/** The model uri, unencoded (`file:///${appId}/${relPath}` for an app file). */
	uri: string;
	/** The 1-based line the diagnostic starts on. */
	line: number;
	/** The diagnostic text. */
	message: string;
	/** Monaco's `MarkerSeverity` (8 is an error). */
	severity: number;
	/** What set the marker (`typescript` for type errors, `rr-appdev` for link errors). */
	owner: string;
}

/** Where the models and markers come from: Monaco in the browser, a fake in tests. */
export interface MarkerSource {
	/** The uri of every model that is loaded. */
	modelUris(): string[];
	/** Every marker Monaco holds, for every model. */
	markers(): MarkerInfo[];
	/**
	 * Calls a listener whenever any marker changes.
	 *
	 * @param listener - Called on each change.
	 * @returns A function that stops the calls.
	 */
	onChange(listener: () => void): () => void;
	/**
	 * Resolves once validation can start: the TypeScript worker is up and holds
	 * the models. A source with nothing to wait for leaves it out.
	 *
	 * @returns A promise that resolves when the markers can begin to arrive.
	 */
	ready?(): Promise<void>;
}

// =============================================================================
// MONACO SOURCE
// =============================================================================

/** The `monaco.languages.typescript` members this file drives (the typings only declare a stub). */
interface MonacoTypescriptWorkers {
	getTypeScriptWorker(): Promise<(...uris: unknown[]) => Promise<unknown>>;
}

/**
 * The marker source backed by the real Monaco. Browser only: it loads Monaco
 * (and wires its workers) the first time, so it is imported lazily and the
 * rest of this file stays loadable under the test runner.
 *
 * `ready()` asks the TypeScript worker for every TypeScript model. Asking is
 * what starts the worker on a cold page and copies those models into it, and
 * Monaco validates a model only once the worker has it. It covers every open
 * app's TypeScript models, not only the one being checked.
 *
 * @returns A marker source over every model and marker Monaco holds.
 */
export async function monacoMarkerSource(): Promise<MarkerSource> {
	const { loadMonaco } = await import('../../../components/monaco/loader');
	const monaco = await loadMonaco();
	return {
		// step: skipEncoding keeps the uri as `file:///${appId}/${relPath}`, even for names that need escaping
		modelUris: () => monaco.editor.getModels().map((model) => model.uri.toString(true)),
		markers: () =>
			monaco.editor.getModelMarkers({}).map((m) => ({
				uri: m.resource.toString(true),
				line: m.startLineNumber,
				message: m.message,
				severity: m.severity,
				owner: m.owner,
			})),
		onChange: (listener) => {
			const subscription = monaco.editor.onDidChangeMarkers(() => listener());
			return () => subscription.dispose();
		},
		ready: async () => {
			const getWorker = await (monaco.languages.typescript as unknown as MonacoTypescriptWorkers).getTypeScriptWorker();
			const uris = monaco.editor
				.getModels()
				.filter((model) => model.getLanguageId() === 'typescript')
				.map((model) => model.uri);
			await getWorker(...uris);
		},
	};
}

// =============================================================================
// SETTLE
// =============================================================================

/**
 * Waits for Monaco to finish validating. Validation starts after a debounce and
 * a trip to the TypeScript worker, and gives no "done" signal. So this waits for
 * the source to be `ready` (the worker is up and holds the models), then counts
 * the markers as settled once none has changed for `quietMs`. A slow worker or a
 * file that keeps changing is cut off at `maxMs`, and a `ready` that fails is
 * skipped: the quiet window still applies.
 *
 * @param src - The marker source.
 * @param opts - `quietMs` (default 1500) and `maxMs` (default 10 000, for the whole wait).
 * @returns A promise that resolves when the markers are quiet or the cap is reached.
 */
export function settleMarkers(src: MarkerSource, opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
	const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
	const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
	return new Promise((resolve) => {
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let windowOpen = false;
		let finished = false;
		const cap = setTimeout(done, maxMs);
		const restart = (): void => {
			clearTimeout(quiet);
			quiet = setTimeout(done, quietMs);
		};
		const stop = src.onChange(() => {
			// step: a change while the worker is still starting says nothing yet; the window opens when it is ready
			if (windowOpen) restart();
		});
		function done(): void {
			finished = true;
			clearTimeout(quiet);
			clearTimeout(cap);
			stop();
			resolve();
		}
		const open = (): void => {
			if (finished) return;
			windowOpen = true;
			restart();
		};
		Promise.resolve()
			.then(() => src.ready?.())
			.then(open, open);
	});
}

// =============================================================================
// READING
// =============================================================================

/**
 * The uri prefix of an app's models.
 *
 * @param appId - The app id.
 * @returns `file:///${appId}/`; the closing slash keeps `app` apart from `app-two`.
 */
function prefixOf(appId: string): string {
	return `file:///${appId}/`;
}

/**
 * Whether a marker is a TypeScript error.
 *
 * @param marker - The marker.
 * @returns True for owner `typescript` at severity Error.
 */
function isTypeError(marker: MarkerInfo): boolean {
	return marker.owner === TYPESCRIPT_OWNER && marker.severity === SEVERITY_ERROR;
}

/**
 * The TypeScript errors in one file.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @param relPath - The file path inside the app (for example `src/App.tsx`).
 * @returns The file's TypeScript errors, in the order Monaco holds them.
 */
function fileTypeErrors(src: MarkerSource, appId: string, relPath: string): MarkerInfo[] {
	const uri = `${prefixOf(appId)}${relPath}`;
	return src.markers().filter((m) => m.uri === uri && isTypeError(m));
}

/**
 * The TypeScript errors across every model of an app.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @returns The app's TypeScript errors, in the order Monaco holds them.
 */
function appTypeErrors(src: MarkerSource, appId: string): MarkerInfo[] {
	const prefix = prefixOf(appId);
	return src.markers().filter((m) => m.uri.startsWith(prefix) && isTypeError(m));
}

/**
 * The files of an app that have a model loaded.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @returns Each loaded model as a path inside the app (for example `src/App.tsx`); empty when the app is not open.
 */
function appModelPaths(src: MarkerSource, appId: string): string[] {
	const prefix = prefixOf(appId);
	return src
		.modelUris()
		.filter((uri) => uri.startsWith(prefix))
		.map((uri) => uri.slice(prefix.length));
}

// =============================================================================
// EVIDENCE
// =============================================================================

/**
 * Reads an app's type errors into check evidence.
 *
 * @param src - The marker source; settle it first (`settleMarkers`) if files just changed.
 * @param app - The app being checked; its `id` is the id its models are keyed by.
 * @param tsFiles - The app's TypeScript files, as paths inside the app (for example `src/App.tsx`).
 * @returns `not_run` when the app has no models, or has TypeScript files and
 *   none of them is loaded (the models are only json, css and the like);
 *   otherwise `fail` with one `${relPath}:${line} ${message}` line per error, or
 *   `pass`. TypeScript files with no model are named in the output and counted
 *   in a passing summary.
 */
export async function appTypeEvidence(src: MarkerSource, app: AppEntry, tsFiles: string[]): Promise<CheckEvidence> {
	const prefix = app.id ? prefixOf(app.id) : undefined;
	const models = new Set(prefix ? src.modelUris().filter((uri) => uri.startsWith(prefix)) : []);
	if (!prefix || models.size === 0) return { step: STEP, ran: RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	const errors = src
		.markers()
		.filter((m) => m.uri.startsWith(prefix) && isTypeError(m))
		.map((m) => ({ relPath: m.uri.slice(prefix.length), line: m.line, message: m.message.replace(/\s*\n\s*/g, ' ') }))
		.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1));
	const checked = tsFiles.filter((file) => models.has(`${prefix}${file}`));
	const unchecked = tsFiles.filter((file) => !models.has(`${prefix}${file}`));

	// step: models of json, css and the like prove nothing about types; with TypeScript files and none of them loaded, nothing was checked
	if (errors.length === 0 && checked.length === 0 && tsFiles.length > 0) return { step: STEP, ran: RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	// step: only the error list is cut; the note on unchecked files comes after it so a long list cannot hide it
	const errorLines = errors.length > 0 ? errors.map((e) => `${e.relPath}:${e.line} ${e.message}`).join('\n') : `no TypeScript errors in ${checked.length} files`;
	const note = unchecked.length > 0 ? `\nNot type-checked (not loaded in the editor): ${unchecked.join(', ')}` : '';
	const output = `${clip(errorLines, 'fix the first errors and check again to see the rest')}${note}`;

	if (errors.length > 0) return { step: STEP, ran: RAN, output, status: 'fail', summary: `types: ${errors.length} errors` };
	const summary = unchecked.length > 0 ? `types clean (${unchecked.length} files not type-checked)` : 'types clean';
	return { step: STEP, ran: RAN, output, status: 'pass', summary };
}

// =============================================================================
// AUTO CHECK — type errors and validate, appended to a save
// =============================================================================

/**
 * Saving an app's TypeScript file returns that file's type errors and the app's
 * total; saving a `.pipe` file returns what validate says. The model sees the
 * result of its own edit at once and fixes it without asking.
 *
 * This is information only. It never counts as a check for the loop's done
 * rule (only the `check` tool does): it reads markers that may not have
 * settled, and it covers one file, not the app.
 *
 * It works by wrapping Rod's `write_file` and `edit_file`. `composeToolkits`
 * is last-mounted-wins by tool name, so a host mounts this toolkit right after
 * `FilesystemTools` and the wrapped pair replaces the originals under the same
 * names, descriptions and parameters. Each wrapper runs the original first and
 * appends its note to the result. An original that throws (a refused write, a
 * missing anchor) throws unchanged with nothing appended, and a check that
 * fails after a good save is named in the note and never fails the save.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** The file tools this toolkit wraps. */
const WRAPPED = new Set(['write_file', 'edit_file']);

/** An app's TypeScript file: the app folder, then the path inside the app. */
const APP_TYPESCRIPT_FILE = /^apps\/([^/]+)\/(.+\.tsx?)$/;

/** What a save says when it cannot read the file's types because the app is not loaded in the editor. */
const NOT_OPEN = "\n\nTypes not checked: the app isn't open.";

/** What a cut error list tells the model to do. */
const CLIP_HINT = 'fix the first errors and save again to see the rest';

// =============================================================================
// TYPES
// =============================================================================

/** What the toolkit needs from the host. */
export interface AutoCheckDeps {
	/** The workspace view the file tools write to; it maps `apps/<folder>` to the app id. */
	vfs: IWorkspaceFileSystem;
	/** Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads). */
	markers: () => Promise<MarkerSource | null>;
	/**
	 * Validates a pipeline file the way `validate_pipeline` does.
	 *
	 * @param path - The workspace path of the `.pipe` file.
	 * @returns The engine's errors and warnings.
	 */
	validate: (path: string) => Promise<{ errors: string[]; warnings: string[] }>;
	/** How long the markers must be quiet and the longest the wait runs, in milliseconds (defaults: 1500 and 10 000; tests pass short ones). */
	settle?: { quietMs?: number; maxMs?: number };
}

// =============================================================================
// PATHS
// =============================================================================

/**
 * Cleans a path the way the file tools do, so a path they accepted maps here
 * to the same file: backslashes become slashes, and leading, trailing and
 * doubled slashes go.
 *
 * @param raw - The path as the model supplied it.
 * @returns The canonical path.
 */
function cleanPath(raw: unknown): string {
	return String(raw ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.join('/');
}

// =============================================================================
// NOTES
// =============================================================================

/**
 * The type note for a saved app file.
 *
 * @param deps - The host dependencies.
 * @param folder - The app's folder under `apps/`.
 * @param relPath - The file's path inside the app (for example `src/App.tsx`).
 * @returns The text to append: the file's errors and the app total, or why types were not checked.
 */
async function typesNote(deps: AutoCheckDeps, folder: string, relPath: string): Promise<string> {
	try {
		const app = (await readApps(deps.vfs, () => false)).find((a) => a.folder === folder);
		if (!app?.id) return `\n\nTypes not checked: apps/${folder} has no manifest id, so its editor models cannot be found.`;

		let src: MarkerSource | null;
		try {
			src = await deps.markers();
		} catch (err) {
			return `\n\nTypes not checked: the editor's type service could not be loaded (${messageOf(err)}).`;
		}

		// step: an app with no models is not open; there is nothing to settle, so do not wait
		if (!src || appModelPaths(src, app.id).length === 0) return NOT_OPEN;
		await settleMarkers(src, deps.settle);

		// step: the file's own model may only have appeared while settling, so look for it now
		if (!appModelPaths(src, app.id).includes(relPath)) return NOT_OPEN;

		const errors = fileTypeErrors(src, app.id, relPath).sort((a, b) => a.line - b.line);
		const total = appTypeErrors(src, app.id).length;
		if (errors.length === 0) return `\n\nType errors in this file: none. App total: ${total}.`;
		const lines = errors.map((e) => `- line ${e.line}: ${e.message.replace(/\s*\n\s*/g, ' ')}`).join('\n');
		return `\n\nType errors in this file (${errors.length}):\n${clip(lines, CLIP_HINT)}\nApp total: ${total}.`;
	} catch (err) {
		return `\n\nTypes not checked: ${messageOf(err)}.`;
	}
}

/**
 * The validate note for a saved pipeline file.
 *
 * @param deps - The host dependencies.
 * @param path - The pipeline file's workspace path.
 * @returns The text to append: `validate_pipeline: OK`, the errors as lines, or why validate could not run.
 */
async function validateNote(deps: AutoCheckDeps, path: string): Promise<string> {
	try {
		const { errors } = await deps.validate(path);
		if (errors.length === 0) return '\n\nvalidate_pipeline: OK';
		const lines = errors.map((e) => `- ${e}`).join('\n');
		return `\n\nvalidate_pipeline: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}:\n${clip(lines, CLIP_HINT)}`;
	} catch (err) {
		return `\n\nvalidate_pipeline: could not run (${messageOf(err)})`;
	}
}

// =============================================================================
// TOOLKIT
// =============================================================================

/**
 * `write_file` and `edit_file` with a check appended to the result of a save.
 * Mount it right after `FilesystemTools`.
 */
export class AutoCheckToolkit extends AgentToolkit {
	readonly name = 'auto-check';
	readonly instructions = '';

	/** The original tools being wrapped. */
	private readonly originals: AgentTool[];
	/** The host dependencies. */
	private readonly deps: AutoCheckDeps;

	/**
	 * Builds the toolkit.
	 *
	 * @param base - The file tools to wrap (`FilesystemTools.tools()`); only `write_file` and `edit_file` are taken from it.
	 * @param deps - The host dependencies.
	 */
	constructor(base: AgentTool[], deps: AutoCheckDeps) {
		super();
		this.originals = base.filter((tool) => WRAPPED.has(tool.name));
		this.deps = deps;
	}

	/**
	 * The wrapped `write_file` and `edit_file`, under their original names.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return this.originals.map(
			(tool) =>
				new AgentTool({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (args) => (await tool.execute(args)) + (await this.noteFor(args.path)),
				})
		);
	}

	/**
	 * The text to append after a save that worked.
	 *
	 * @param rawPath - The path the model supplied.
	 * @returns A type note for an app's TypeScript file, a validate note for a `.pipe` file, and nothing for any other file.
	 */
	private async noteFor(rawPath: unknown): Promise<string> {
		const path = cleanPath(rawPath);
		const appFile = APP_TYPESCRIPT_FILE.exec(path);
		if (appFile) return typesNote(this.deps, appFile[1], appFile[2]);
		if (path.endsWith('.pipe')) return validateNote(this.deps, path);
		return '';
	}
}
