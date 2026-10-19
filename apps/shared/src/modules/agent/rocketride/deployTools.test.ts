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
// DEPLOY TOOL TESTS — the user says yes first, secrets stay out, deploy_app keeps its version
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';

import type { AgentHost } from '../host';
import { createMemoryWorkspace } from '../testing/memoryWorkspace';
import type { AgentTool } from '../tools';
import { AppToolkit } from './appTools';
import { declined, type ConfirmFn } from './common';
import { DeployToolkit } from './deployTools';

// =============================================================================
// HELPERS
// =============================================================================

/** One row of an app's version rail, as `listDeployments` returns it. */
interface Row {
	registryVersion: number;
	buildStatus: string;
	state: string;
}

/** A version row: built and private unless told otherwise. */
function row(registryVersion: number, buildStatus = 'ok', state = 'private'): Row {
	return { registryVersion, buildStatus, state };
}

/** What the fake client answers. */
interface Answers {
	/** What `deploy.get` (deploy_status) returns. */
	status?: unknown;
	/** What `listDeployments` returns on each call; the last repeats. */
	listings?: Row[][];
	/** What `deploy.add` returns. */
	added?: unknown;
}

/**
 * A fake client with the deploy and app methods the tools call, cast to the real type.
 *
 * @param answers - What it answers.
 * @returns The client and the name of each method called, in order.
 */
function fakeClient(answers: Answers = {}): { client: RocketRideClient; calls: string[] } {
	const calls: string[] = [];
	const deployment = { teamId: 't1', projectId: 'p1', version: 3, state: 'enabled', schedules: {} };
	const listings = answers.listings ?? [[]];
	let listed = 0;
	const method = (name: string, value: () => unknown) => async () => {
		calls.push(name);
		return value();
	};
	const client = {
		deploy: {
			add: method('add', () => answers.added ?? { artifact: { version: 3 } }),
			deploy: method('deploy', () => deployment),
			get: method('get', () => answers.status ?? deployment),
			enable: method('enable', () => deployment),
			disable: method('disable', () => deployment),
			remove: method('remove', () => deployment),
			setSchedule: method('setSchedule', () => deployment),
		},
		listDeployments: method('listDeployments', () => listings[Math.min(listed++, listings.length - 1)]),
		buildLog: method('buildLog', () => ({ log: '' })),
		publishApp: method('publishApp', () => ({ publish: {} })),
		submitApp: method('submitApp', () => ({ artifact: {} })),
	};
	return { client: client as unknown as RocketRideClient, calls };
}

/**
 * A confirm function that records each title it was asked and answers the same each time.
 *
 * @param answer - What the user says.
 * @returns The function and the titles it was asked.
 */
function fakeConfirm(answer: boolean): { confirm: ConfirmFn; asked: string[] } {
	const asked: string[] = [];
	return {
		confirm: async (title) => {
			asked.push(title);
			return answer;
		},
		asked,
	};
}

/**
 * One of a toolkit's tools by name.
 *
 * @param toolkit - The toolkit.
 * @param name - The tool name.
 * @returns The tool.
 */
function toolOf(toolkit: { tools(): AgentTool[] }, name: string): AgentTool {
	const found = toolkit.tools().find((t) => t.name === name);
	assert.ok(found, `${name} is mounted`);
	return found;
}

/** The deploy tools over a fake client. */
function deployTools(client: RocketRideClient, confirm: ConfirmFn): DeployToolkit {
	return new DeployToolkit(() => client, createMemoryWorkspace({}), confirm);
}

/** The app tools over a fake client and a workspace with one app, `a-ui`, whose manifest id is `acme.a`. */
function appTools(client: RocketRideClient, confirm: ConfirmFn): AppToolkit {
	const host: AgentHost = {
		vfs: createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) }),
		guides: { paths: () => [], read: async () => '' },
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array([1, 2, 3]),
		devSession: () => null,
	};
	return new AppToolkit(() => client, host, confirm, { pollMs: 0, buildWaitMs: 50 });
}

/** A small flat pipeline that is ready to deploy: it has a name and a project id. */
const PIPE = { name: 'Daily digest', components: [{ id: 'webhook_1', provider: 'webhook', config: { mode: 'Source' } }], source: 'webhook_1', project_id: 'p1' };

// =============================================================================
// THE USER SAYS YES FIRST
// =============================================================================

test('deploy and schedule actions ask first: a no does nothing, a yes runs once', async () => {
	// Each case: the tool, its arguments, the client method it runs, and the title of its question.
	const cases: Array<[tool: string, args: Record<string, unknown>, method: string, title: string]> = [
		['deploy_to_team', { project_id: 'p1', version: 3, team_id: 't1' }, 'deploy', 'Deploy p1'],
		['deploy_add', { pipeline: PIPE, deploy_to: 't1' }, 'add', 'Deploy p1'],
		['deploy_set_schedule', { project_id: 'p1', source_id: 'webhook_1', schedule: '0 9 * * 1-5', team_id: 't1' }, 'setSchedule', 'Schedule p1'],
		['deploy_enable', { project_id: 'p1', team_id: 't1' }, 'enable', 'Enable p1'],
		['deploy_disable', { project_id: 'p1', team_id: 't1' }, 'disable', 'Disable p1'],
		['deploy_remove', { project_id: 'p1', team_id: 't1' }, 'remove', 'Remove p1'],
	];
	for (const [tool, args, method, title] of cases) {
		for (const yes of [false, true]) {
			const { client, calls } = fakeClient();
			const { confirm, asked } = fakeConfirm(yes);
			const result = await toolOf(deployTools(client, confirm), tool).execute(args);
			assert.deepEqual(asked, [title], `${tool}: the user is asked once`);
			assert.deepEqual(calls, yes ? [method] : [], `${tool}: ${yes ? 'a yes runs it' : 'a no runs nothing'}`);
			if (!yes) assert.equal(result, declined(title), tool);
		}
	}
});

test('publish_app asks first; a no publishes nothing', async () => {
	const { client, calls } = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	const { confirm, asked } = fakeConfirm(false);
	const result = await toolOf(appTools(client, confirm), 'publish_app').execute({ app: 'a-ui', target: 'public' });
	assert.equal(asked.length, 1);
	assert.equal(result, declined(asked[0]));
	assert.deepEqual(calls, ['listDeployments'], 'nothing was published or submitted');
});

// =============================================================================
// SECRETS
// =============================================================================

test('results hide secrets but keep placeholders and task_token', async () => {
	const status = { teamId: 't1', projectId: 'p1', task_token: 'tk-fake-0001', schedules: { webhook_1: { apikey: 'sk-fake-not-a-real-key', token: 'tok-fake', api_key: '${ROCKETRIDE_OPENAI_KEY}' } } };
	const { client } = fakeClient({ status });
	const text = await toolOf(deployTools(client, fakeConfirm(false).confirm), 'deploy_status').execute({ project_id: 'p1', team_id: 't1' });
	assert.doesNotMatch(text, /sk-fake-not-a-real-key|tok-fake/);
	assert.match(text, /\[redacted\]/);
	assert.match(text, /\$\{ROCKETRIDE_OPENAI_KEY\}/, 'a placeholder names a key without holding it');
	assert.match(text, /tk-fake-0001/, 'the run tools hand out task_token on purpose');
});

// =============================================================================
// deploy_app
// =============================================================================

test("deploy_app waits for the version it uploaded, not a teammate's newer one", async () => {
	// The upload reply names v5; a teammate's v6 lands beside it and is built first.
	const listings = [[row(4)], [row(6, 'building'), row(5, 'queued'), row(4)], [row(6), row(5, 'building'), row(4)], [row(6), row(5), row(4)]];
	const { client } = fakeClient({ listings, added: { artifact: { registryVersion: 5, buildStatus: 'queued' } } });
	const result = await toolOf(appTools(client, fakeConfirm(true).confirm), 'deploy_app').execute({ app: 'a-ui', message: 'Mine' });
	assert.equal(result, 'Deployed v5; server build OK.');
});
