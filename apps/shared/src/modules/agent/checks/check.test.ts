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
// CHECK TOOL TESTS — the pipeline and app checks, called the way the model calls them
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';

import type { ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import type { AgentDevSession, AgentHost } from '../host';
import { createMemoryWorkspace } from '../testing/memoryWorkspace';
import { appChecker, type AppCheckOptions } from './appCheck';
import type { MarkerInfo } from './appTypes';
import { CheckLedger, CheckToolkit } from './check';
import type { CheckReport, Checker } from './check';
import { pipelineChecker } from './pipelineCheck';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Calls the check tool over one checker, as the model would.
 *
 * @param checker - The checker to mount.
 * @param target - The pipeline path or app to check.
 * @returns The text the model reads and the report the ledger recorded.
 */
async function runCheck(checker: Checker, target: string): Promise<{ text: string; report: CheckReport }> {
	const ledger = new CheckLedger();
	const text = await new CheckToolkit([checker], ledger).tools()[0].execute({ kind: checker.kind, target });
	return { text, report: ledger.latestByTarget()[0] };
}

/** Each step of a report with its status. */
function steps(report: CheckReport): string[] {
	return report.evidence.map((e) => `${e.step} ${e.status}`);
}

// =============================================================================
// PIPELINE CHECK
// =============================================================================

/** The task token the fake engine hands out. Obviously fake. */
const TOKEN = 'task-fake-0001';

/** Where the test pipeline lives. */
const PATH = 'pipelines/chat.pipe';

/** A small flat pipeline: a chat source feeding an OpenAI model. */
const PIPE = {
	components: [
		{ id: 'chat_1', provider: 'chat', config: { mode: 'Source' } },
		{ id: 'llm_1', provider: 'llm_openai', config: { apikey: '${ROCKETRIDE_OPENAI_KEY}' }, input: [{ lane: 'questions', from: 'chat_1' }] },
	],
	source: 'chat_1',
	project_id: 'p1',
};

/** What the fake engine answers; an Error is thrown. */
interface Answers {
	validate?: unknown;
	use?: unknown;
	send?: unknown;
	status?: unknown;
}

/**
 * A fake engine with the methods the pipeline check calls, cast to the real type.
 * By default the pipeline validates, starts, answers and sits running, as a chat source does.
 *
 * @param answers - What it answers.
 * @returns The client, how many tasks it started, and the tokens it was asked to stop.
 */
function fakeEngine(answers: Answers = {}): { client: RocketRideClient; started: () => number; stopped: string[] } {
	let started = 0;
	const stopped: string[] = [];
	const reply = (value: unknown): unknown => {
		if (value instanceof Error) throw value;
		return value;
	};
	const client = {
		getServices: async () => ({ services: { chat: {}, webhook: {}, dropper: {}, llm_openai: {} } }),
		validate: async () => answers.validate ?? { errors: [], warnings: [] },
		use: async () => {
			started += 1;
			return reply(answers.use ?? { token: TOKEN, projectId: 'p1', source: 'chat_1' });
		},
		send: async (_token: string, input: string) => reply(answers.send ?? { name: 'result', text: `echo ${input}` }),
		terminate: async (token: string) => {
			stopped.push(token);
		},
		getTaskStatus: async () => answers.status ?? { state: 3, completed: false, errors: [], warnings: [] },
		log: {
			chapters: async () => ({ chapters: [{ beginTime: 1, beginSeq: 7, endTime: null, outcome: null }], segments: [], horizonSeq: 0, completed: false }),
			read: async () => ({ events: [{ type: 'event', event: 'apaevt_flow', body: { op: 'leave', id: 1, component: 'llm_1', eventTime: 1, logSeq: 8, trace: { lane: 'answers' } } }] }),
		},
	};
	return { client: client as unknown as RocketRideClient, started: () => started, stopped };
}

/**
 * A pipeline checker over a workspace holding `pipeline` at PATH, that does not wait between polls.
 *
 * @param client - The fake engine.
 * @param pipeline - The pipeline file's flat config.
 * @returns The checker.
 */
function pipeCheck(client: RocketRideClient, pipeline: unknown = PIPE): Checker {
	return pipelineChecker(() => client, createMemoryWorkspace({ [PATH]: JSON.stringify({ pipeline }) }), { runWaitMs: 200, pollMs: 0 });
}

test('a broken pipeline fails the check', async () => {
	// Each case: what the engine says, the step that fails, and whether a task was started (and so must be stopped).
	const cases: Array<[name: string, answers: Answers, failed: string, ran: boolean]> = [
		['validate errors', { validate: { errors: [{ message: 'lane questions has no source', id: 'llm_1' }], warnings: [] } }, 'validate', false],
		['errors in the run status', { status: { state: 3, completed: false, errors: ['llm_1: authentication failed'], warnings: [] } }, 'run', true],
		['a reply that carries an error, though the status is clean', { send: { name: 'x', error: { message: 'Incorrect API key provided' } } }, 'run', true],
	];
	for (const [name, answers, failed, ran] of cases) {
		const { client, stopped } = fakeEngine(answers);
		const { text, report } = await runCheck(pipeCheck(client), PATH);
		assert.match(text, /^CHECK FAILED: /, name);
		assert.deepEqual(
			report.evidence.filter((e) => e.status === 'fail').map((e) => e.step),
			[failed],
			name
		);
		assert.deepEqual(stopped, ran ? [TOKEN] : [], `${name}: a started task is stopped`);
	}
});

test('the source is found the way the engine finds it', async () => {
	const [chat, llm] = PIPE.components;
	const hook = { id: 'hook_1', provider: 'webhook', config: { mode: 'Source' } };
	const drop = { id: 'drop_1', provider: 'dropper', config: { mode: 'Source' } };
	// Each case: the pipeline, and the run summary; only a found text source is started.
	const cases: Array<[name: string, pipeline: unknown, run: string]> = [
		['no source field runs the one Source component', { ...PIPE, source: undefined }, 'pipeline run OK'],
		['an empty source field is the same as none', { ...PIPE, source: '' }, 'pipeline run OK'],
		['a named source wins over other Source components', { ...PIPE, components: [chat, drop, llm] }, 'pipeline run OK'],
		['a dropper source takes files, not the sample text', { ...PIPE, components: [drop, llm], source: 'drop_1' }, 'run not checked: dropper source needs other input'],
		['a source the pipeline does not define', { ...PIPE, source: 'missing_1' }, "run not checked: the pipeline's source component was not found"],
		['no Source component and no source field', { ...PIPE, components: [{ ...chat, config: {} }, llm], source: undefined }, 'run not checked: the pipeline has no source component'],
		['the engine reads the mode in exact case, so source is not a Source component', { ...PIPE, components: [{ ...chat, config: { mode: 'source' } }, llm], source: undefined }, 'run not checked: the pipeline has no source component'],
		['several Source components and no source field', { ...PIPE, components: [chat, hook, llm], source: undefined }, 'run not checked: the pipeline has several source components and names none'],
	];
	for (const [name, pipeline, run] of cases) {
		const { client, started } = fakeEngine();
		const { report } = await runCheck(pipeCheck(client, pipeline), PATH);
		assert.equal(report.evidence[1].summary, run, name);
		assert.equal(started(), run === 'pipeline run OK' ? 1 : 0, `${name}: whether a run started`);
	}
});

test('the check stops the task it started, even when an error escapes', async () => {
	// The run and log steps catch their own errors; reading this reply's error field throws outside them.
	const { client, stopped } = fakeEngine({
		send: {
			get error(): never {
				throw new Error('boom');
			},
		},
	});
	await assert.rejects(runCheck(pipeCheck(client), PATH), { message: 'boom' });
	assert.deepEqual(stopped, [TOKEN]);
});

test('a pipeline the user already has running is left alone', async () => {
	const { client, stopped } = fakeEngine({ use: new Error('Pipeline is already running.') });
	const { report } = await runCheck(pipeCheck(client), PATH);
	assert.deepEqual(steps(report), ['validate pass', 'run not_run', 'log not_run']);
	assert.equal(report.evidence[1].summary, 'run not checked: the pipeline is already running');
	assert.deepEqual(stopped, [], 'a task the check did not start is never stopped');
});

// =============================================================================
// APP CHECK
// =============================================================================

/** Timings small enough for a test. */
const APP_FAST: AppCheckOptions = { build: { buildWaitMs: 1000, settleMs: 20, runtimeGraceMs: 20 }, types: { quietMs: 10, maxMs: 200 } };

/** One healthy app, one whose manifest has no id, one whose package.json no longer parses. */
const APP_FILES = {
	'apps/daybook-ui/package.json': JSON.stringify({ appManifest: { id: 'daybook', name: 'Daybook' } }),
	'apps/daybook-ui/src/App.tsx': 'export default function App() { return null; }',
	'apps/noid-ui/package.json': JSON.stringify({ appManifest: { name: 'No Id' } }),
	'apps/broken-ui/package.json': '{ "appManifest": { "id": "broken", ',
};

/** A TypeScript error in the app's one source file. */
const TYPE_ERROR: MarkerInfo = { uri: 'file:///daybook/src/App.tsx', line: 3, message: "Type 'string' is not assignable to type 'number'.", severity: 8, owner: 'typescript' };

/**
 * A dev session with the Design preview open, whose rebuild goes building, then `end`.
 *
 * @param end - Where the build ends.
 * @param consoleError - A console error the app logs while it builds, if any.
 * @returns The session.
 */
function session(end: WatchStatus = { state: 'ok' }, consoleError?: string): AgentDevSession {
	const watchers = new Set<(s: WatchStatus) => void>();
	const consoles = new Set<(r: ConsoleRow) => void>();
	return {
		appId: 'daybook',
		previewAttached: true,
		rebuild: async () => {
			for (const l of [...watchers]) l({ state: 'building' });
			setTimeout(() => {
				if (consoleError) for (const l of [...consoles]) l({ time: '12:00:00', level: 'error', text: consoleError });
				for (const l of [...watchers]) l(end);
			}, 5);
		},
		subscribeConsole: (l) => {
			consoles.add(l);
			return () => consoles.delete(l);
		},
		subscribeErrors: () => () => undefined,
		subscribeWatch: (l) => {
			l({ state: 'ok' });
			watchers.add(l);
			return () => watchers.delete(l);
		},
	};
}

/**
 * An app checker over APP_FILES, with `markers` in the editor.
 *
 * @param dev - The app's dev session.
 * @param markers - The markers Monaco holds.
 * @returns The checker.
 */
function appCheck(dev: AgentDevSession, markers: MarkerInfo[] = []): Checker {
	const host: AgentHost = {
		vfs: createMemoryWorkspace(APP_FILES),
		guides: { paths: () => [], read: async () => '' },
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array(),
		devSession: () => dev,
	};
	return appChecker(host, async () => ({ modelUris: () => ['file:///daybook/src/App.tsx'], markers: () => markers, onChange: () => () => undefined }), APP_FAST);
}

test('type errors fail the app check', async () => {
	const { text, report } = await runCheck(appCheck(session(), [TYPE_ERROR]), 'daybook-ui');
	assert.match(text, /^CHECK FAILED: daybook/);
	assert.deepEqual(steps(report), ['types fail', 'build pass', 'runtime pass']);
});

test('a failed build fails the app check', async () => {
	const { text, report } = await runCheck(appCheck(session({ state: 'error', reason: '"left-pad" is not a declared dependency' })), 'daybook-ui');
	assert.match(text, /^CHECK FAILED: daybook/);
	assert.deepEqual(steps(report), ['types pass', 'build fail']);
});

test('console errors are reported but do not block the app check', async () => {
	const { text, report } = await runCheck(appCheck(session({ state: 'ok' }, 'Warning: Each child in a list should have a unique "key" prop.')), 'daybook-ui');
	assert.match(text, /^CHECK PASSED: daybook/);
	assert.deepEqual(steps(report), ['types pass', 'build pass', 'runtime pass', 'console pass']);
});

test('a broken manifest fails the app check', async () => {
	const cases: Array<[folder: string, summary: string]> = [
		['noid-ui', 'manifest: appManifest has no id'],
		['broken-ui', 'manifest: package.json has no readable appManifest'],
	];
	for (const [folder, summary] of cases) {
		const { text, report } = await runCheck(appCheck(session()), folder);
		assert.match(text, /^CHECK FAILED: /, folder);
		assert.equal(report.evidence[0].summary, summary, folder);
	}
});
