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
// APP CHECK — the checker behind `check { kind: 'app' }`
// =============================================================================

/**
 * An app check leaves the evidence of two halves, in this order:
 *
 * 1. `types`: the TypeScript errors Monaco keeps for the app's files (see
 *    `appTypes.ts`). Monaco validates some time after a file changes, so the
 *    markers are settled first.
 * 2. `build`, `runtime` and `console`: a rebuild in the Design preview and what
 *    it raised (see APP BUILD below). With no preview, one `not_run` item says so.
 *
 * Both halves always run, so a failed type check does not hide a failed build.
 * Anything that cannot run is `not_run` and named, never a pass and never a
 * failure: an editor whose type service did not load, a closed preview. An app
 * whose manifest is missing, broken or has no id is a `fail` (`manifest`), because
 * the agent can fix its `package.json` and a broken one must not pass. A
 * `package.json` that cannot be read at all throws instead: the manifest may be
 * fine, so the check records nothing rather than tell the agent to fix it.
 *
 * The report is filed under the app's manifest id (its folder when it has none),
 * whichever of the folder, id or name the model passed, so the checks line has
 * one entry per app.
 */

import type { AppErrorRow, ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import type { AgentDevSession, AgentHost } from '../host';
import { brief, clip, messageOf } from '../rocketride/common';
import { findApp, readApps } from '../rocketride/inventory';
import type { AppEntry } from '../rocketride/inventory';
import { appTypeEvidence, settleMarkers } from './appTypes';
import type { MarkerSource } from './appTypes';
import type { CheckEvidence, CheckReport, Checker } from './check';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Folders inside an app that the platform owns; their files are not the app's. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);

/** The app's source files that Monaco type-checks. */
const TYPESCRIPT_FILE = /\.tsx?$/;

/** What the types step does, as a short phrase (the types evidence names its own when it runs). */
const TYPES_RAN = "read the TypeScript errors Monaco keeps for the app's open files";

/** A marker source with no models, so `appTypeEvidence` answers `not_run` the way it does for an app that is not open. */
const NO_MARKERS: MarkerSource = { modelUris: () => [], markers: () => [], onChange: () => () => undefined };

// =============================================================================
// TYPES
// =============================================================================

/** The timings of the app checker. */
export interface AppCheckOptions {
	/** The build step's timings (defaults: 60 000, 300 and 1500 ms). */
	build?: AppBuildOptions;
	/** How long Monaco's markers must be quiet, and the longest the wait runs, in milliseconds (defaults: 1500 and 10 000). */
	types?: { quietMs?: number; maxMs?: number };
}

// =============================================================================
// FILES
// =============================================================================

/**
 * Lists an app's TypeScript files.
 *
 * @param vfs - The workspace view.
 * @param dir - The folder to walk, from the workspace root.
 * @param base - The path of `dir` inside the app ('' for the app folder itself).
 * @returns Every `.ts` and `.tsx` file under `dir` as a path inside the app (for example `src/App.tsx`), skipping `node_modules`, `dist` and `build`; in path order.
 */
async function typeScriptFiles(vfs: IWorkspaceFileSystem, dir: string, base = ''): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await vfs.list(dir)) {
		const rel = `${base}${entry.name}`;
		if (entry.type === 'dir') {
			if (!SKIPPED_DIRS.has(entry.name)) found.push(...(await typeScriptFiles(vfs, `${dir}/${entry.name}`, `${rel}/`)));
		} else if (TYPESCRIPT_FILE.test(entry.name)) {
			found.push(rel);
		}
	}
	return found.sort();
}

// =============================================================================
// STEPS
// =============================================================================

/**
 * The type evidence for an app.
 *
 * @param app - The app, with an id.
 * @param markers - The host's marker source getter.
 * @param settle - How long to let Monaco's markers settle.
 * @param files - The app's TypeScript files.
 * @returns The evidence; `not_run` when the editor is not there, did not load, or holds none of the app's files.
 */
async function typesStep(app: AppEntry, markers: () => Promise<MarkerSource | null>, settle: AppCheckOptions['types'], files: string[]): Promise<CheckEvidence> {
	let src: MarkerSource | null;
	try {
		src = await markers();
	} catch (err) {
		return { step: 'types', ran: TYPES_RAN, output: `The editor's type service could not be loaded: ${messageOf(err)}`, status: 'not_run', summary: 'types not checked: the editor could not be loaded' };
	}
	if (!src) return appTypeEvidence(NO_MARKERS, app, files);
	await settleMarkers(src, settle);
	return appTypeEvidence(src, app, files);
}

/**
 * The evidence for an app whose manifest has no usable id. This fails, because
 * the agent can always fix it, and a `package.json` it broke while editing would
 * otherwise read as an app with nothing to check.
 *
 * @param app - The app.
 * @returns A failing `manifest` item that says how to fix it, then a `not_run` item for each half it blocked.
 */
function noIdEvidence(app: AppEntry): CheckEvidence[] {
	const why = app.error ?? 'appManifest has no id';
	const file = `${app.path}/package.json`;
	const output = `${file} cannot be used as an app: ${why}. Fix the JSON and the appManifest (it needs an id and a name) in ${file}, then check again. Types and build were not checked.`;
	return [
		{ step: 'manifest', ran: `read the appManifest in ${file}`, output, status: 'fail', summary: `manifest: ${why}` },
		{ step: 'types', ran: TYPES_RAN, output, status: 'not_run', summary: 'types not checked: the manifest has no usable id' },
		{ step: 'build', ran: BUILD_RAN, output, status: 'not_run', summary: 'build not checked: the manifest has no usable id' },
	];
}

// =============================================================================
// CHECKER
// =============================================================================

/**
 * The checker for apps.
 *
 * @param host - The agent host: its workspace lists the apps and their files, and it finds the app's running dev session.
 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
 * @param opts - Timings; tests pass short ones.
 * @returns A checker of kind 'app'. `check(target)` takes the app's folder, manifest id or name and throws, naming the apps that exist, when none matches, and with the read error when the app's package.json cannot be read.
 */
export function appChecker(host: AgentHost, markers: () => Promise<MarkerSource | null>, opts: AppCheckOptions = {}): Checker {
	return {
		kind: 'app',
		async check(target: string): Promise<CheckReport> {
			const apps = await readApps(host.vfs, (id) => host.devSession(id) !== null);
			const app = findApp(apps, target);
			const report = (evidence: CheckEvidence[]): CheckReport => ({ kind: 'app', target: app.id ?? app.folder, evidence });
			// step: a read that failed says nothing about the manifest, so there is no evidence to record either way
			if (app.unreadable) throw new Error(`Cannot check ${app.folder} (${app.error}), so nothing was checked. Run check again; if it keeps failing, tell the user this app was not checked.`);
			if (!app.id) return report(noIdEvidence(app));

			const files = await typeScriptFiles(host.vfs, app.path);
			const types = await typesStep(app, markers, opts.types, files);
			const build = await appBuildEvidence(host.devSession(app.id), opts.build);
			return report([types, ...build]);
		},
	};
}

// =============================================================================
// APP BUILD — a preview rebuild, with its build, runtime and console errors
// =============================================================================

/**
 * The build half of an app check. It rebuilds the app in its Design preview and
 * reports what the build, the running app and the console say. Rod's dev session
 * builds only while a preview is attached (`devSession.ts:599`), so with no
 * preview the evidence says so and nothing is built.
 *
 * What counts as what, because a check that wrongly passes lets the agent claim
 * the app runs and one that cannot pass on a healthy app leaves it stuck:
 *
 * - `rebuild()` queues and coalesces: while a build runs it sets a flag and
 *   returns at once, and the running build is followed by another. So the wait
 *   is on the watch state, not on the promise: the result is the last `ok` or
 *   `error` that no `building` or `installing` follows within `settleMs`.
 * - Every feed replays its backlog on subscribe, including the watch state. The
 *   replay is dropped, so a stale `ok` or an error from an earlier build is never
 *   this rebuild's result. A rebuild that never starts a build therefore times
 *   out as `not_run`: nothing new happened, so nothing is proven.
 * - A hot refresh (`target: 'hot refresh'`) swaps one module into a mounted app
 *   and reports `ok` with no `building` before it. It can land while the full
 *   build is still running, so it is never this rebuild's result.
 * - A build that does not settle in `buildWaitMs` is `not_run`, not `fail`: the
 *   app may be fine. The summary says whether no build started or one was seen
 *   running that did not finish.
 * - Runtime errors are the error rows that arrive after this rebuild's first
 *   `building` or `installing` until `runtimeGraceMs` after the build settles,
 *   which is when the app mounts and throws. The old app can still raise errors
 *   until the new build begins, and those are not this rebuild's. The shell's
 *   harmless `ResizeObserver loop` window errors are not counted: a healthy app
 *   raises them and would never pass. A clean result means none arrived in that
 *   window, and the output says so.
 * - Console errors are reported but never fail the check: the preview shell wraps
 *   the whole window's `console.error`, so shell code, libraries and React's dev
 *   warnings land there on a healthy app. Uncaught errors (runtime) block; console
 *   errors inform.
 * - A failed build mounts nothing, so runtime and console are not read; the build
 *   evidence carries the error rows the build raised and says what was skipped.
 *
 * Output goes through `clip`, so a long list is cut and says how to see the rest.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** How long the build may take to settle before it is called still running, in milliseconds. */
const DEFAULT_BUILD_WAIT_MS = 60_000;

/** How long after an `ok` or `error` no new build may start for the result to stand, in milliseconds. */
const DEFAULT_SETTLE_MS = 300;

/** How long after the build settles the preview is watched for mount errors, in milliseconds. */
const DEFAULT_RUNTIME_GRACE_MS = 1500;

/** The watch `target` of a hot refresh, which swaps one module into a mounted app without a build. */
const HOT_REFRESH_TARGET = 'hot refresh';

/** Window errors the shell forwards that a healthy app raises (the browser's ResizeObserver notices), which are not failures. */
const BENIGN_ERROR = /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

/** What the build step does, as a short phrase. */
const BUILD_RAN = 'rebuild the app in its Design preview and wait for the build to settle';

/** What the runtime step does, as a short phrase. */
const RUNTIME_RAN = 'watch the preview for runtime errors from the rebuild until just after the app mounts';

/** What the console step does, as a short phrase. */
const CONSOLE_RAN = "read the preview's console errors from the rebuild";

/** How the model gets the preview open. Only the user can, until the run mounts a view tool (open question 1). */
const OPEN_PREVIEW = "ask the user to open the app's Design preview in the App Builder, then run check again";

/** What the output says when the preview is closed. */
const PREVIEW_CLOSED_OUTPUT = `The app's Design preview is not open, and the app is built only while it is, so nothing was built and no runtime or console errors were read. To include them, ${OPEN_PREVIEW}.`;

// =============================================================================
// TYPES
// =============================================================================

/** The timings of the build step. */
interface AppBuildOptions {
	/** How long the build may take to settle before it is called still running, in milliseconds (default 60 000). */
	buildWaitMs?: number;
	/** How long after an `ok` or `error` no new build may start, in milliseconds (default 300). */
	settleMs?: number;
	/** How long after the build settles the preview is watched for mount errors, in milliseconds (default 1500). */
	runtimeGraceMs?: number;
}

/** How the wait for the build ended. */
type BuildOutcome = { kind: 'settled'; status: WatchStatus } | { kind: 'timeout'; started: boolean } | { kind: 'unstarted'; message: string };

// =============================================================================
// EVIDENCE
// =============================================================================

/**
 * A piece of build evidence for a step that did not run.
 *
 * @param step - The step name.
 * @param ran - What would have run.
 * @param output - What the output says.
 * @param summary - Why it did not, and what was not checked.
 * @returns The evidence.
 */
function notRun(step: string, ran: string, output: string, summary: string): CheckEvidence {
	return { step, ran, output, status: 'not_run', summary };
}

/**
 * Writes a wait as a person would.
 *
 * @param ms - The wait in milliseconds.
 * @returns For example `60 s`, or `150 ms` for a wait under a second.
 */
function describeWait(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Writes error rows as one line each.
 *
 * @param rows - The preview's error rows.
 * @returns `source: message` per row (just the message when there is no source), with a multi-line message on one line.
 */
function errorLines(rows: AppErrorRow[]): string[] {
	return rows.map((row) => `${row.source ? `${row.source}: ` : ''}${row.message.replace(/\s*\n\s*/g, ' ')}`);
}

/**
 * Cuts a list of lines that is too long.
 *
 * @param lines - The lines.
 * @returns The lines as text, cut with a note on how to see less.
 */
function listText(lines: string[]): string {
	return clip(lines.join('\n'), 'fix the first errors and check again to see the rest');
}

// =============================================================================
// REBUILD
// =============================================================================

/**
 * Rebuilds the app in its Design preview and reports what it saw.
 *
 * @param session - The app's dev session, or null when none is running.
 * @param opts - The timings; tests pass short ones.
 * @returns With no session or no preview attached, one `not_run` item
 *   (`preview closed: build not checked`). Otherwise `build` (`build OK` or
 *   `build failed: ${reason}`) and, when the build is OK, `runtime` (`runtime
 *   clean` or `runtime: ${n} errors`) and, only when there are some, `console`
 *   (`console: ${n} errors`, which is reported but does not fail the check). A
 *   build that does not start or settle in time, or a rebuild that cannot run, is
 *   a single `not_run` item. It never throws.
 */
async function appBuildEvidence(session: AgentDevSession | null, opts: AppBuildOptions = {}): Promise<CheckEvidence[]> {
	if (!session || !session.previewAttached) return [notRun('build', 'rebuild the app in its Design preview', PREVIEW_CLOSED_OUTPUT, 'preview closed: build not checked')];

	const buildWaitMs = opts.buildWaitMs ?? DEFAULT_BUILD_WAIT_MS;
	const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
	const runtimeGraceMs = opts.runtimeGraceMs ?? DEFAULT_RUNTIME_GRACE_MS;

	const errorRows: AppErrorRow[] = [];
	const consoleRows: ConsoleRow[] = [];
	const stops: Array<() => void> = [];
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	// step: each subscribe replays its backlog before it returns; those rows and that state are older than this rebuild
	let replaying = true;
	// step: the rows before this rebuild's first building or installing belong to the old app
	let building = false;
	// step: whether any build status has come in since the replay, for naming a timeout
	let started = false;

	try {
		const outcome = await new Promise<BuildOutcome>((resolve) => {
			capTimer = setTimeout(() => resolve({ kind: 'timeout', started }), buildWaitMs);
			// step: one push per subscribe, so a later subscribe that throws still leaves the earlier ones to be released
			stops.push(
				session.subscribeErrors((row) => {
					if (!replaying && building && !BENIGN_ERROR.test(row.message)) errorRows.push(row);
				})
			);
			stops.push(
				session.subscribeConsole((row) => {
					if (!replaying && building && row.level === 'error') consoleRows.push(row);
				})
			);
			stops.push(
				session.subscribeWatch((status) => {
					// step: a hot refresh lands mid-build with no building before it; it is no build result
					if (replaying || status.target === HOT_REFRESH_TARGET) return;
					// step: an ok or error stands only if no new build starts within settleMs; a queued rebuild starts right after the running one
					if (status.state === 'ok' || status.state === 'error') {
						started = true;
						clearTimeout(quietTimer);
						quietTimer = setTimeout(() => resolve({ kind: 'settled', status }), settleMs);
					} else if (status.state === 'building' || status.state === 'installing') {
						started = true;
						building = true;
						clearTimeout(quietTimer);
					}
				})
			);
			replaying = false;
			// step: its promise is no signal, because a rebuild that only queues resolves at once
			Promise.resolve()
				.then(() => session.rebuild())
				.catch((err: unknown) => resolve({ kind: 'unstarted', message: messageOf(err) }));
		});

		if (outcome.kind === 'timeout') {
			const wait = describeWait(buildWaitMs);
			if (!outcome.started) return [notRun('build', BUILD_RAN, `No build started within ${wait} of the rebuild request, so nothing was built or checked. The preview may be paused or closed; ${OPEN_PREVIEW}.`, `no build started within ${wait}`)];
			return [notRun('build', BUILD_RAN, `The build did not finish within ${wait}, so it was not seen to pass or fail. It may still be running; check again in a moment.`, `build still running after ${wait}`)];
		}
		if (outcome.kind === 'unstarted') return [notRun('build', BUILD_RAN, `The rebuild could not run: ${outcome.message}`, `build not run: ${brief(outcome.message)}`)];

		if (outcome.status.state === 'error') {
			const reason = outcome.status.reason?.trim() || 'no reason reported';
			const raised = errorRows.length > 0 ? `\nErrors the build raised:\n${listText(errorLines(errorRows))}` : '';
			const output = `${clip(`Build failed: ${reason}`, 'the reason is long; fix the first problem and check again')}${raised}\nRuntime and console were not checked because the build failed.`;
			return [{ step: 'build', ran: BUILD_RAN, output, status: 'fail', summary: `build failed: ${brief(reason)}` }];
		}

		// step: the app mounts after the build settles; give its errors time to arrive
		await new Promise((resolve) => setTimeout(resolve, runtimeGraceMs));
		const took = outcome.status.durationMs !== undefined ? ` in ${outcome.status.durationMs} ms` : '';
		const evidence: CheckEvidence[] = [{ step: 'build', ran: BUILD_RAN, output: `Build finished OK${took}.`, status: 'pass', summary: 'build OK' }];
		if (errorRows.length > 0) {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: listText(errorLines(errorRows)), status: 'fail', summary: `runtime: ${errorRows.length} errors` });
		} else {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: `No runtime errors arrived from the rebuild until ${describeWait(runtimeGraceMs)} after the build settled.`, status: 'pass', summary: 'runtime clean' });
		}
		if (consoleRows.length > 0) {
			evidence.push({ step: 'console', ran: CONSOLE_RAN, output: listText(consoleRows.map((row) => row.text.replace(/\s*\n\s*/g, ' '))), status: 'pass', summary: `console: ${consoleRows.length} errors` });
		}
		return evidence;
	} catch (err) {
		// step: subscribing to a session that is gone throws; that is a check that could not run, not an app that failed
		return [notRun('build', BUILD_RAN, `The rebuild could not run: ${messageOf(err)}`, `build not run: ${brief(messageOf(err))}`)];
	} finally {
		clearTimeout(capTimer);
		clearTimeout(quietTimer);
		for (const stop of stops) stop();
	}
}
