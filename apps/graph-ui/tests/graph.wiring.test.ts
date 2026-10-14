// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WIRING GUARDS: React-side rules that the pure tests cannot see
// =============================================================================
//
// No React harness runs under node:test, so the rules that decide whether the UI stays in
// step with its state are pinned by reading the source. Each one guards a failure that
// only shows in a browser:
//
//   --  Escape must close the inspector: disposing the graph session when a new result
//       arrives would drop the surface's subscription, so closing the inspector would
//       change the state and nothing would re-render.
//   --  a refreshed discovery list hands back a NEW endpoint object for the same connection;
//       rebuilding the graph session from it would silently drop the user's selection,
//       inspector and expansions.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (...parts: string[]): string => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
/** Source without comments, so a rule is checked against code only. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('the surface disposes its graph session when the session is replaced or the surface unmounts, never from the effect that loads a new result', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const loadEffect = surface.slice(surface.indexOf('graphSession.load(result)') - 200, surface.indexOf('graphSession.load(result)') + 200);
	assert.doesNotMatch(loadEffect, /dispose\(\)/, 'dispose() beside load(result) runs on every new result');
	assert.match(surface, /useEffect\(\(\) => \(\) => graphSession\.dispose\(\), \[graphSession\]\)/);
});

test('the graph session is built from the connection key and refs, not from objects that change when discovery refreshes', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const factory = surface.slice(surface.indexOf('const graphSession = useMemo'), surface.indexOf('useEffect(() => () => graphSession.dispose()'));
	assert.match(factory, /\[endpoint\.key\]\)/, 'its dependency list is the key alone');
	// Every read of a changing value goes through `latest.current`: strip those, and no bare dialect/session/writable is left.
	const bare = factory.replace(/latest\.current\.(dialect|session|writable|announce)/g, '');
	assert.doesNotMatch(bare, /\b(dialect|writable)\b\s*[?.)]|[(,]\s*(session|dialect|writable)\s*[,)]/, 'it closes over a changing object');
	assert.match(factory, /latest\.current\./, 'what changes over time is read through a ref');
});

test('every open drawer and dialog goes through the shell: no graph-ui code handles Escape or swallows key events above them', () => {
	for (const file of ['components/InspectorPanel.tsx', 'components/HistoryPanel.tsx', 'components/RunSurface.tsx', 'views/ConnectionsView.tsx', 'components/ConnectionDrawer.tsx']) {
		const text = code(read(...file.split('/')));
		assert.doesNotMatch(text, /stopPropagation/, `${file} stops event propagation`);
		assert.doesNotMatch(text, /addEventListener\(\s*['"]key/, `${file} registers its own key listener`);
	}
});

test('opening a workbench from the connection drawer closes the drawer first, so it cannot sit above the workbench', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	const onOpen = view.slice(view.indexOf('onOpen={'), view.indexOf('onClose={() => setDrawerKey(null)}'));
	assert.match(onOpen, /setDrawerKey\(null\)/);
	assert.ok(onOpen.indexOf('setDrawerKey(null)') < onOpen.indexOf('open(endpoint)'));
});

test('the inspector closes through the session, and its panel is rendered from the same state the session publishes', () => {
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.match(inspector, /onClose=\{\(\) => session\.inspect\(null\)\}/);
	assert.match(inspector, /const target: IInspectTarget \| null = state\.inspect/);
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.match(surface, /useSyncExternalStore\(graphSession\.subscribe, graphSession\.getState, graphSession\.getState\)/);
});

// A re-probe (a restart of ANY pipeline, a shell reconnect, Test connection) takes the probe away for a moment. Both
// connection documents keep a run surface that has opened and pause it, rather than unmount it and lose the results,
// graph, expansions, inspector and row limit.
test('the workbench and the write console keep an opened run surface through a re-probe, and pass the pause reason down', () => {
	for (const file of ['WorkbenchView.tsx', 'WriteConsoleView.tsx']) {
		const view = code(read('views', file));
		assert.match(view, /surfaceGate\(/, `${file} decides through surfaceGate`);
		assert.match(view, /gate\.mounted \?/, `${file} mounts the surface on the gate`);
		assert.doesNotMatch(view, /\{(view\.openable|allowed) \? \(/, `${file} still unmounts the surface whenever the connection is not openable`);
		const surface = view.slice(view.indexOf('<RunSurface'), view.indexOf('/>', view.indexOf('<RunSurface')));
		assert.match(surface, /paused=\{gate\.paused\}/, `${file} tells the surface why it is paused`);
	}
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.match(surface, /canRun: \(\) => [^\n]*paused == null/, 'a paused surface sends nothing');
});

// A request is consumed by the surface through the host's slot, never de-duplicated by a ref the surface
// re-creates on every mount; a request the surface cannot run now is never queued to run later.
test('the run surface takes its editor request from the host\'s slot, and the hosts never queue a run for a surface that is not on screen', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/loadSlot\.take\(\)/.test(surface), 'the surface takes the request');
	assert.ok(!/loadRequest\.seq === handled\.current/.test(surface), 'a per-mount ref decides what was handled');
	for (const file of ['WorkbenchView.tsx', 'WriteConsoleView.tsx']) {
		const view = code(read('views', file));
		assert.ok(/useState\(createLoadSlot\)/.test(view), `${file} keeps one slot for the life of the document`);
		const surfaceTag = view.slice(view.indexOf('<RunSurface'), view.indexOf('/>', view.indexOf('<RunSurface')));
		assert.ok(/loadSlot=\{slot\}/.test(surfaceTag), `${file} hands the slot to the surface`);
	}
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/const runNow = run && now\.mounted && now\.paused === null;/.test(workbench) && /slot\.put\(\{ text, run: runNow \}\)/.test(workbench), 'a run is asked for only while the surface can run it');
});

// A write is not counted in `record`, which the shared runner skips once the document is closed: a write that lands
// after the console closed still marks other graphs out of date.
test('the write console counts a write where it is sent, not in the record step a closed document skips', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const execute = surface.slice(surface.indexOf('execute: async'), surface.indexOf('settle:'));
	assert.ok(/countWrite\(dataVersions, endpoint\.key, \(\) => session\.invoke<ReadQueryResult>\(TOOL\.execute/.test(execute), 'execute is sent through countWrite');
	const record = surface.slice(surface.indexOf('record: (run) =>'), surface.indexOf('summarize:'));
	assert.ok(/isAbandonedWrite\(mode, run\.outcome\)/.test(record), 'record counts only a write the user stopped waiting for');
	assert.ok(!/mayHaveChangedData/.test(surface));
	assert.ok(/describeWriteFailure\(message, error\)/.test(surface), 'the write console words its failures as possibly applied');
});

// A run is settled by its mode: the write console's runs are not settled as 'rows' with the read toggle's limit.
test('the run surface settles, records and describes a run through the mode-aware helpers', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/settle: \(_run, result\) => settleRun\(mode, result\)/.test(surface), 'settle follows the mode');
	assert.ok(/patch: limitPatch\(mode, p\.limit\)/.test(surface), 'a limit is recorded only where one is sent');
	assert.ok(/historySummaryOf\(run, Date\.now\(\)\)/.test(surface), 'history keeps an affected count');
	assert.ok(/resultMeta\(displayed/.test(surface), 'the result line shows the affected count');
});

// The busy sentence says "stop waiting for it", so the control is offered for every request, not only a path search.
test('the graph offers Stop waiting for whatever it is waiting on, in the toolbar and in the inspector', () => {
	const view = code(read('components', 'GraphView.tsx'));
	assert.ok(/\{busy && <Button[^>]*onClick=\{\(\) => session\.stopWaiting\(\)\}>Stop waiting<\/Button>\}/.test(view), 'the toolbar offers it whenever a request runs');
	assert.ok(!/state\.busy === 'path' && <Button/.test(view), 'not only for a path search');
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.ok(/state\.busy !== null && <Button[^>]*onClick=\{\(\) => session\.stopWaiting\(\)\}>Stop waiting<\/Button>/.test(inspector), 'the inspector offers it beside Refresh');
});

// Run stays disabled for as long as a statement runs, Stop waiting shown or not: a press then would do nothing.
test('Run is disabled for as long as a statement runs, and a run that cannot start says why', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const buttons = surface.match(/<Button variant="(primary|ghost)" disabled=\{[^}]*\} onClick=\{\(\) => run\((false|true)\)\}/g) ?? [];
	assert.equal(buttons.length, 2, 'Run and Run all');
	for (const button of buttons) assert.ok(button.includes('disabled={runner.running || blocked !== null}'), button);
	const startRun = surface.slice(surface.indexOf('const startRun = useCallback'), surface.indexOf('const run = useCallback'));
	assert.ok(/runRefusal\(\{ running: runner\.running, blocked \}\)/.test(startRun), 'startRun refuses with a sentence');
	const confirm = surface.slice(surface.indexOf('onConfirm={'), surface.indexOf('onCancel={'));
	assert.ok(/runRefusal\(/.test(confirm), 'so does confirming a write');
});

// The write confirmation is the shell's ConfirmDialog, which focuses its confirm button when it mounts, so an Enter
// right after Ctrl/Cmd+Enter (or a double Enter) would execute the write. WriteConfirmDialog renders that dialog and
// moves focus to Cancel from its OWN mount effect, which React runs after the dialog's (a parent's effects run after
// its children's in the same commit).
// An effect in RunSurface keyed on the dialog being open is not enough. Under <React.StrictMode> (the shell renders in
// it) a development build re-runs the mount effects of what was just mounted (the dialog, so Execute takes the focus
// again) but not RunSurface's update effect, so focus would end on Execute. A mount effect of the component that
// renders the dialog is re-run with it, after it. No React harness runs here, so the shape is pinned by the source.
test('the write confirmation opens with focus on Cancel, never on Execute, under StrictMode too', () => {
	const confirmation = code(read('components', 'WriteConfirmDialog.tsx'));
	assert.ok(/import \{[^}]*\bfocusCancelIn\b[^}]*\} from 'shared\/explorer\/components\/PatternConfirmDialog';/.test(confirmation), 'the shared focus step is used');
	assert.ok(/useEffect\(\(\) => \{\s*focusCancelIn\(anchor\.current, WRITE_CANCEL_LABEL\);\s*\}, \[\]\);/.test(confirmation), 'a mount effect of the component that renders the dialog moves focus to Cancel');
	assert.equal(confirmation.match(/useEffect\(/g)?.length, 1, 'and it is the only effect there');
	const start = confirmation.indexOf('<ConfirmDialog');
	assert.ok(start > 0, 'the component renders the shell dialog itself, so it is the dialog\'s parent');
	const dialog = confirmation.slice(start, confirmation.indexOf('onConfirm={', start));
	assert.ok(/cancelLabel=\{WRITE_CANCEL_LABEL\}/.test(dialog), 'the Cancel button carries the label the focus step looks for');
	assert.ok(/message=\{\s*<div ref=\{anchor\}>/.test(dialog), 'the anchor sits inside the dialog');

	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/import \{ WriteConfirmDialog \} from '\.\/WriteConfirmDialog';/.test(surface));
	assert.ok(/\{confirm && \(\s*<WriteConfirmDialog\s+content=\{confirm\.content\}/.test(surface), 'the console mounts it while a confirmation is pending');
	assert.doesNotMatch(surface, /<ConfirmDialog\b/, 'the console renders no write dialog of its own');
	assert.doesNotMatch(surface, /focusCancelIn|confirmOpen|confirmAnchor/, 'no RunSurface effect moves the focus: StrictMode does not re-run it');
});

// The empty state never replaces the card grid when there are cards: a stopped, unreachable or No access node keeps
// its card, so the reason and Test connection the message points to can be reached.
test('the landing renders its cards whenever there are any, under its message, and the empty state alone only when there is no card', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/const landing = landingView\(status, endpoints, error\);/.test(view), 'the layout comes from landingView');
	assert.ok(!/\{empty \? \(/.test(view), 'an empty state still replaces the card grid');
	assert.ok(/\{landing\.message && !landing\.cards && \(\s*<EmptyState/.test(view), 'the empty state stands alone only without cards');
	assert.ok(/\{landing\.message && landing\.cards && \(/.test(view), 'with cards, the message sits above them');
	assert.ok(/\{landing\.cards && \(\s*<div style=\{styles\.cardGrid\}>/.test(view), 'the grid renders whenever there are cards');
});

// On a change of user, organization or team (or a sign-out) the shared store forgets every connection, so the open
// workbench and write-console documents must not keep the previous identity's results on screen.
test('a change of identity closes every connection document and clears the per-connection caches', () => {
	const app = code(read('GraphApp.tsx'));
	assert.ok(/const fingerprint = identityFingerprint\(identityFromConnectResult\(identity\)\);/.test(app), 'the app tracks the fingerprint the shared store tracks');
	assert.ok(/useEffect\(\(\) => \{\s*forgetConnections\(getDocs\(\), \{ schemas \}\);\s*\}, \[fingerprint\]\);/.test(app), 'every change of it forgets the connections');
});

// The drawer starts fresh for every card: one shared instance would show the last Test result on the next card opened.
test('the connection drawer starts fresh for every card, and words its Test result through testResultText', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/<ConnectionDrawer\s+key=\{drawerKey \?\? ''\}/.test(view), 'the drawer is keyed on the card it shows');
	const drawer = code(read('components', 'ConnectionDrawer.tsx'));
	assert.ok(/setTested\(testResultText\(result\)\)/.test(drawer), 'a missing result is not read as a failed probe');
});

// A store reset (sign-out, change of identity) left the drawer open on its key, so it could reopen by itself with the
// previous identity's Test result once discovery listed the same key again.
test('the connection drawer closes when the store forgets its card', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/useEffect\(\(\) => \{\s*const next = drawerKeyAfter\(drawerKey, endpoints\);\s*if \(next !== drawerKey\) setDrawerKey\(next\);\s*\}, \[drawerKey, endpoints\]\);/.test(view), 'an effect drops a key the store no longer lists');
});
