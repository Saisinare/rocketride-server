// =============================================================================
// MIT License
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
// EXPLORER DISCOVERY — role-aware, owner-aware, token-contained
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverToolEndpoints, mapWithConcurrency, readTaskRow } from './discovery';
import { fakeWorld, row } from './testing';
import { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from '../types';
import type { IExplorerIdentity, IRoleSpec } from '../types';
import { legacyKeyFromKey, parseEndpointKey } from '../keys';

const DB = new Set(['db_postgres', 'db_mysql']);
const VECTOR = new Set(['rocketride_vector']);

/**
 * Discover over a world with the SQL/Graph single-role spec.
 *
 * @param rows - The task rows.
 * @param providers - The provider set.
 * @param identity - Who is signed in.
 * @returns The discovered endpoints and the world.
 */
async function discover(rows: ReturnType<typeof row>[], providers: ReadonlySet<string> = DB, identity: IExplorerIdentity | null = null) {
	const world = fakeWorld(rows);
	const found = await discoverToolEndpoints(world.client, { providers, roles: SINGLE_TOOLS_ROLE, identity });
	return { world, found };
}

describe('discoverToolEndpoints — one tools role (SQL, Graph)', () => {
	it('lists each running task with ITS OWN token and never looks a token up', async () => {
		const { world, found } = await discover([row({ pipeline: { project_id: 'p1', components: [{ id: 'db_1', provider: 'db_postgres' }] } }), row({ source: 'tools_2', pipeline: { project_id: 'p2', components: [{ id: 'db_9', provider: 'db_mysql' }] } })]);
		assert.deepEqual(found.map((f) => f.endpoint.nodeId), ['db_1', 'db_9']);
		assert.deepEqual(found.map((f) => f.token), [world.rows[0]!.token, world.rows[1]!.token]);
		// The fake client has no getTaskToken / listTasks at all: nothing could have called them.
		assert.equal(world.getTasksCalls, 1);
		assert.deepEqual(world.pipelineFetches, []);
	});

	it('is not capped at one page: 250 running tasks all appear', async () => {
		const rows = Array.from({ length: 250 }, (_, i) => row({ source: `s${i}`, pipeline: { project_id: `p${i}`, name: `Pipe ${String(i).padStart(3, '0')}`, components: [{ id: 'db_1', provider: 'db_postgres' }] }, name: `Pipe ${String(i).padStart(3, '0')}` }));
		const { found } = await discover(rows);
		assert.equal(found.length, 250);
		assert.equal(new Set(found.map((f) => f.endpoint.key)).size, 250);
	});

	it('keeps a developer run and the team deployment of the SAME project, source and node apart', async () => {
		const dev = row();
		const deploy = row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' });
		const { found } = await discover([dev, deploy]);
		assert.equal(found.length, 2);
		const [a, b] = found.map((f) => f.endpoint);
		assert.notEqual(a!.key, b!.key);
		assert.deepEqual(new Set(found.map((f) => f.token)), new Set([dev.token, deploy.token]));
		assert.deepEqual(new Set(found.map((f) => `${f.endpoint.runKind}/${f.endpoint.ownerKind}`)), new Set(['dev/user', 'deploy/team']));
	});

	it('never merges two teams\' deployments or a personal deploy with the user\'s dev run', async () => {
		const rows = [
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', teamId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-2', teamId: 'team-2' }),
			row({ runKind: 'deploy', ownerKind: 'user', ownerId: 'u1' }),
			row(),
		];
		const { found } = await discover(rows);
		assert.equal(new Set(found.map((f) => f.endpoint.key)).size, 4);
	});

	it('gives SQL\'s old key ONLY to the caller\'s own dev run', async () => {
		const { found } = await discover([
			row(),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'user', ownerId: 'u1' }),
		]);
		const byRun = Object.fromEntries(found.map((f) => [`${f.endpoint.runKind}/${f.endpoint.ownerKind}`, f.endpoint.legacyKey]));
		assert.equal(byRun['dev/user'], 'proj-1:tools_1:db_1');
		assert.equal(byRun['deploy/team'], null);
		assert.equal(byRun['deploy/user'], null);
		for (const { endpoint } of found) assert.equal(endpoint.legacyKey, legacyKeyFromKey(endpoint.key));
	});

	it('handles a pipeline with no project_id: projectId is empty, no legacy key, and the key is never token-derived', async () => {
		const noProject = (source: string) => row({ source, pipeline: null, name: 'Anon' });
		const a = noProject('tools_1');
		a.pipeline = { components: [{ id: 'db_1', provider: 'db_postgres' }] };
		const b = noProject('tools_2');
		b.pipeline = { components: [{ id: 'db_1', provider: 'db_postgres' }] };
		const { found } = await discover([a, b]);
		assert.equal(found.length, 2);
		for (const { endpoint } of found) {
			assert.equal(endpoint.projectId, '');
			assert.equal(endpoint.legacyKey, null);
			assert.equal(endpoint.key.includes('tk_sentinel'), false);
		}
		assert.notEqual(found[0]!.endpoint.key, found[1]!.endpoint.key);
	});

	it('describes an endpoint fully, with the tools source bound and nothing else', async () => {
		const { found } = await discover([row()]);
		const { endpoint } = found[0]!;
		assert.deepEqual({ ...endpoint, key: '<k>' }, {
			key: '<k>',
			legacyKey: 'proj-1:tools_1:db_1',
			projectId: 'proj-1',
			pipelineName: 'Pipeline A',
			runKind: 'dev',
			ownerKind: 'user',
			ownerId: 'u1',
			teamId: 'team-1',
			roles: { tools: { source: 'tools_1' } },
			missingRoles: [],
			source: 'tools_1',
			nodeId: 'db_1',
			nodeName: 'Orders DB',
			provider: 'db_postgres',
			state: 'probing',
			running: true,
		});
		assert.deepEqual(parseEndpointKey(endpoint.key)?.roles, { tools: 'tools_1' });
	});

	it('NEVER puts a token inside an endpoint: serialising endpoints leaks nothing', async () => {
		const { world, found } = await discover([row(), row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' })]);
		const text = JSON.stringify(found.map((f) => f.endpoint));
		for (const r of world.rows) assert.equal(text.includes(r.token), false);
		assert.equal(text.includes('tk_sentinel'), false);
		for (const f of found) assert.equal(JSON.stringify(f.endpoint.roles).includes('tk_'), false);
	});

	it('keeps only components of the exact provider set and names each one', async () => {
		const r = row({ pipeline: { project_id: 'p1', components: [
			{ id: 'llm_1', provider: 'llm_openai', name: 'GPT' },
			{ id: 'pg_1', provider: 'db_postgres', name: 'Analytics' },
			{ id: 'my_1', provider: 'db_mysql' },
			{ id: 'g_1', provider: 'graph_neo4j' },
			{ provider: 'db_mysql' },
			{ id: 'noprov' },
			{ id: '', provider: 'db_mysql' },
		] } });
		const { found } = await discover([r]);
		assert.deepEqual(found.map((f) => `${f.endpoint.nodeId}:${f.endpoint.nodeName}`), ['my_1:my_1', 'pg_1:Analytics']);
	});

	it('reads components from the row, and falls back to getTaskPipeline(token) only when the row has none', async () => {
		const withComponents = row();
		const bare = row({ source: 'tools_2', pipeline: { project_id: 'p2', name: 'Pipe B' } });
		const world = fakeWorld([withComponents, bare]);
		world.pipelines[bare.token] = { components: [{ id: 'db_7', provider: 'db_mysql' }] };
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.deepEqual(found.map((f) => f.endpoint.nodeId).sort(), ['db_1', 'db_7']);
		assert.deepEqual(world.pipelineFetches, [bare.token]);
	});

	it('skips ONE task whose pipeline cannot be read and keeps discovering the rest', async () => {
		const bad = row({ source: 'tools_9', pipeline: { project_id: 'bad' } });
		const good = row();
		const world = fakeWorld([bad, good]);
		world.pipelines[bad.token] = 'throw';
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.deepEqual(found.map((f) => f.endpoint.projectId), ['proj-1']);
	});

	it('drops rows that cannot be used (no token, no source, not objects) without throwing', async () => {
		const world = fakeWorld([]);
		world.getTasksImpl = async () => [null, 'x', 7, { source: 's' }, { token: 't' }, { ...row() }] as unknown as Array<Record<string, unknown>>;
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.equal(found.length, 1);
	});

	it('propagates a getTasks failure (the only thing that aborts discovery)', async () => {
		const world = fakeWorld([]);
		world.getTasksImpl = async () => { throw new Error('connection lost'); };
		await assert.rejects(discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE }), /connection lost/);
	});

	it('reads ownerKind from an older server that does not stamp it: deploy is team-owned, anything else user-owned', async () => {
		const old = row({ runKind: 'deploy', ownerKind: '' });
		const older = row({ runKind: 'dev', ownerKind: '' });
		const { found } = await discover([old, older]);
		assert.deepEqual(found.map((f) => f.endpoint.ownerKind).sort(), ['team', 'user']);
	});

	it('hints whether the identity can call tools, without ever deciding it', async () => {
		const identity: IExplorerIdentity = { userId: 'u1', orgId: 'o1', devTeam: 't0', teamPermissions: { 'team-1': ['task.monitor'], 'team-2': ['task.monitor', 'task.data'] }, orgPermissions: [] };
		const { found } = await discover([
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-2', source: 'tools_2' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-3', source: 'tools_3' }),
			row({ source: 'tools_4' }),
		], DB, identity);
		const hints = Object.fromEntries(found.map((f) => [f.endpoint.ownerId + '/' + f.endpoint.source, f.callHint]));
		assert.equal(hints['team-1/tools_1'], false);
		assert.equal(hints['team-2/tools_2'], true);
		assert.equal(hints['team-3/tools_3'], undefined);
		assert.equal(hints['u1/tools_4'], true);
		assert.equal(found.every((f) => f.endpoint.state === 'probing'), true);
	});

	it('lists only runs whose team belongs to the signed-in organization: the caller\'s own runs in another organization are left out', async () => {
		// Signed in to org B, a member of teams b1 and b2. The server still lists
		// the caller's own runs from org A (owner visibility survives an org switch).
		const identity: IExplorerIdentity = { userId: 'u1', orgId: 'org-B', devTeam: 'team-b1', teamPermissions: { 'team-b1': ['task.data'], 'team-b2': ['task.monitor'] }, orgPermissions: [] };
		const { found } = await discover([
			row({ teamId: 'team-a1', source: 'own_dev_in_A' }),
			row({ teamId: 'team-a1', runKind: 'deploy', ownerKind: 'user', ownerId: 'u1', source: 'own_personal_deploy_in_A' }),
			row({ teamId: 'team-b1', source: 'own_dev_in_B' }),
			// A dev run under the organization's OTHER team is still this organization's.
			row({ teamId: 'team-b2', source: 'own_dev_in_B_other_team' }),
			row({ teamId: 'team-b2', runKind: 'deploy', ownerKind: 'team', ownerId: 'team-b2', source: 'team_deploy_in_B' }),
		], DB, identity);
		assert.deepEqual(found.map((f) => f.endpoint.source).sort(), ['own_dev_in_B', 'own_dev_in_B_other_team', 'team_deploy_in_B']);
		// No token of a left-out run is handed back for the vault.
		const tokens = found.map((f) => f.token);
		assert.equal(tokens.some((token) => token?.includes('_in_A')), false);
	});

	it('keeps every run when the identity cannot tell its organization\'s teams, or a row names no team', async () => {
		const rows = [row({ teamId: 'team-a1', source: 's1' }), row({ teamId: '', source: 's2' })];
		const noTeams: IExplorerIdentity = { userId: 'u1', orgId: 'org-B', devTeam: 'team-b1' };
		assert.equal((await discover(rows, DB, noTeams)).found.length, 2);
		assert.equal((await discover(rows, DB, null)).found.length, 2);
		const withTeams: IExplorerIdentity = { ...noTeams, teamPermissions: { 'team-b1': [] } };
		assert.deepEqual((await discover(rows, DB, withTeams)).found.map((f) => f.endpoint.source), ['s2']);
	});

	it('sorts by pipeline name, then node id, then key', async () => {
		const z = row({ name: 'Zeta', source: 'tools_1', pipeline: { project_id: 'pz', components: [{ id: 'z1', provider: 'db_mysql' }] } });
		const a = row({ name: 'Alpha', source: 'tools_2', pipeline: { project_id: 'pa', components: [{ id: 'b', provider: 'db_mysql' }, { id: 'a', provider: 'db_mysql' }] } });
		const { found } = await discover([z, a]);
		assert.deepEqual(found.map((f) => `${f.endpoint.pipelineName}/${f.endpoint.nodeId}`), ['Alpha/a', 'Alpha/b', 'Zeta/z1']);
	});
});

describe('discoverToolEndpoints — role map (Vector\'s ingest_1 / chat_1 / tools_1, mocked)', () => {
	const vec = (source: string, over: Partial<ReturnType<typeof row>> = {}) => row({ source, pipeline: { project_id: 'vp', name: 'Vector', components: [{ id: 'vec_1', provider: 'rocketride_vector', name: 'Store' }] }, name: 'Vector', ...over });

	/**
	 * Discover over the vector role map.
	 *
	 * @param rows - Rows.
	 * @returns Found endpoints.
	 */
	async function discoverVector(rows: ReturnType<typeof row>[], spec: IRoleSpec = VECTOR_ROLES) {
		const world = fakeWorld(rows);
		return discoverToolEndpoints(world.client, { providers: VECTOR, roles: spec });
	}

	it('groups the three running sources of one project into ONE connection, calling through the tools task', async () => {
		const rows = [vec('ingest_1'), vec('chat_1'), vec('tools_1')];
		const found = await discoverVector(rows);
		assert.equal(found.length, 1);
		const { endpoint, token } = found[0]!;
		assert.deepEqual(endpoint.roles, { ingest: { source: 'ingest_1' }, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.deepEqual(endpoint.missingRoles, []);
		assert.equal(endpoint.state, 'probing');
		assert.equal(endpoint.source, 'tools_1');
		assert.equal(token, rows[2]!.token);
		assert.equal(endpoint.legacyKey, null);
	});

	it('reports a missing optional role explicitly and stays callable', async () => {
		const found = await discoverVector([vec('chat_1'), vec('tools_1')]);
		assert.equal(found.length, 1);
		assert.deepEqual(found[0]!.endpoint.roles, { ingest: null, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.deepEqual(found[0]!.endpoint.missingRoles, ['ingest']);
		assert.equal(found[0]!.endpoint.state, 'probing');
	});

	it('marks the connection stopped when the REQUIRED tools role is not running, and holds no token for it', async () => {
		const found = await discoverVector([vec('ingest_1'), vec('chat_1')]);
		assert.equal(found.length, 1);
		const { endpoint, token } = found[0]!;
		assert.equal(endpoint.state, 'stopped');
		assert.equal(endpoint.running, false);
		assert.deepEqual(endpoint.missingRoles, ['tools']);
		assert.equal(endpoint.source, '');
		assert.equal(token, null);
		assert.match(endpoint.stateDetail ?? '', /tools/);
	});

	it('keeps the connection\'s key stable while its optional sources start and stop', async () => {
		const all = (await discoverVector([vec('ingest_1'), vec('chat_1'), vec('tools_1')]))[0]!.endpoint.key;
		const noIngest = (await discoverVector([vec('chat_1'), vec('tools_1')]))[0]!.endpoint.key;
		const onlyTools = (await discoverVector([vec('tools_1')]))[0]!.endpoint.key;
		assert.equal(all, noIngest);
		assert.equal(all, onlyTools);
	});

	it('NEVER borrows a source from another owner or run kind: dev and deploy of one project are two connections', async () => {
		const rows = [
			vec('ingest_1'), vec('tools_1'),
			vec('chat_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
		];
		const found = await discoverVector(rows);
		assert.equal(found.length, 2);
		const dev = found.find((f) => f.endpoint.runKind === 'dev')!.endpoint;
		const deploy = found.find((f) => f.endpoint.runKind === 'deploy')!.endpoint;
		assert.deepEqual(dev.roles, { ingest: { source: 'ingest_1' }, chat: null, tools: { source: 'tools_1' } });
		assert.deepEqual(deploy.roles, { ingest: null, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.notEqual(dev.key, deploy.key);
	});

	it('does not merge two users\' dev runs or two teams\' deployments of the same project id', async () => {
		const found = await discoverVector([
			vec('tools_1', { ownerId: 'u1' }),
			vec('tools_1', { ownerId: 'u2' }),
			vec('chat_1', { ownerId: 'u2' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'tA', teamId: 'tA' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'tB', teamId: 'tB' }),
		]);
		assert.equal(found.length, 4);
		assert.equal(found.filter((f) => f.endpoint.ownerId === 'u2')[0]!.endpoint.missingRoles.join(','), 'ingest');
		assert.equal(found.filter((f) => f.endpoint.ownerId === 'u1')[0]!.endpoint.missingRoles.join(','), 'ingest,chat');
	});

	it('does not group rows whose pipeline carries no project id: the callable row wins, the stopped lookalike never hides it', async () => {
		const a = vec('ingest_1');
		a.pipeline = { name: 'x', components: [{ id: 'vec_1', provider: 'rocketride_vector' }] };
		const b = vec('tools_1');
		b.pipeline = { name: 'x', components: [{ id: 'vec_1', provider: 'rocketride_vector' }] };
		for (const rows of [[a, b], [b, a]]) {
			const found = await discoverVector(rows);
			assert.equal(found.length, 1);
			// The ingest row was NOT merged into it: ingest stays reported as not running.
			assert.deepEqual(found[0]!.endpoint.roles, { ingest: null, chat: null, tools: { source: 'tools_1' } });
			assert.equal(found[0]!.endpoint.state, 'probing');
		}
	});

	it('ignores a project none of whose running sources fills a role', async () => {
		assert.deepEqual(await discoverVector([vec('other_1')]), []);
	});
});

describe('mapWithConcurrency', () => {
	it('never runs more than the limit at once and keeps result order', async () => {
		let now = 0;
		let peak = 0;
		const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			now += 1;
			peak = Math.max(peak, now);
			await new Promise((resolve) => setImmediate(resolve));
			now -= 1;
			return n * 2;
		});
		assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
		assert.equal(peak, 3);
	});

	it('treats a limit below one as one, and an empty input as empty', async () => {
		assert.deepEqual(await mapWithConcurrency([], 4, async (n: number) => n), []);
		assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (n) => n), [1, 2]);
	});
});

describe('readTaskRow', () => {
	it('reads exactly the keys a live engine sends and defaults the rest', () => {
		const live = { description: 'd', name: 'n', ownerId: 'o', ownerKind: 'user', pipeline: { project_id: 'p' }, runKind: 'dev', source: 's', status: 'ok', teamId: 't', token: 'tk' };
		assert.deepEqual(readTaskRow(live), { ...live });
		assert.equal(readTaskRow({ ...live, runKind: undefined })?.runKind, 'dev');
		assert.equal(readTaskRow({ ...live, name: '' })?.name, 's');
		assert.equal(readTaskRow({ ...live, pipeline: 'nope' })?.pipeline, null);
	});
});
