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
// CONNECT SESSION — SQL Explorer's face over the shared session
// =============================================================================
//
// A session resolves the owning task's token from the endpoint store's vault.
// A task that restarts fails the call with the server's TASK_STOPPED code —
// the same failure a really-stopped task produces — so retrying is a per-CALL
// decision: reads may be repeated, a write must not be, and even a read is
// repeated only after re-discovery shows the SAME endpoint running again.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'shell';
import type { ISqlEndpoint } from '../src/connect';
import { createSqlSession } from '../src/connect/session';
import { currentRows, registerEndpoint, resetEndpoints } from './support';

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** One recorded tool invocation. */
interface IToolCall {
	/** The token the call rode on. */
	token: string;
	/** The tool name. */
	tool: string;
	/** The tool input. */
	input: Record<string, unknown>;
}

/** A fake client plus the call log it records. */
interface IFakeClient {
	/** The client handed to the session. */
	client: RocketRideClient;
	/** Every tool invocation, in order. */
	calls: IToolCall[];
}

/**
 * Build a fake client: `getTasks` answers a re-discovery from the registered
 * rows, and `tool` behaves per call.
 *
 * @param behave - Called per invocation; throw to fail it, return the result.
 * @returns The fake client and its call log.
 */
function fakeClient(behave: (call: IToolCall, index: number) => unknown): IFakeClient {
	const calls: IToolCall[] = [];
	const client = {
		getTasks: async () => currentRows(),
		getTaskPipeline: async () => undefined,
		tool: async ({ token, tool, input }: { token: string; tool: string; input: Record<string, unknown> }) => {
			const call: IToolCall = { token, tool, input };
			calls.push(call);
			return behave(call, calls.length - 1);
		},
	} as unknown as RocketRideClient;
	return { client, calls };
}

/**
 * An error shaped like the SDK's DAPException: a message and a server code.
 *
 * @param message - The message.
 * @param code - The code.
 * @returns The error.
 */
function stopped(message = 'Task was stopped', code: string | undefined = 'TASK_STOPPED'): Error {
	return Object.assign(new Error(message), code === undefined ? {} : { code });
}

/** A behaviour that fails the first invocation as a restarting task and succeeds afterwards. */
const failFirst = (result: unknown) => (_call: IToolCall, index: number): unknown => {
	if (index === 0) throw stopped();
	return result;
};

let endpoint: ISqlEndpoint;

beforeEach(async () => {
	resetEndpoints();
	endpoint = await registerEndpoint('session-suite');
});

// =============================================================================
// EXECUTE — THE WRITE-SAFETY RULE
// =============================================================================

describe('execute retry policy', () => {
	it('does NOT re-send a statement that was not marked idempotent, even when the task restarted', async () => {
		// The regression this rule exists for: the task restarted and a blind
		// retry would run the INSERT twice.
		const fake = fakeClient(failFirst({ rows: [], affected_rows: 1 }));
		const session = createSqlSession(fake.client, endpoint);

		await assert.rejects(session.execute("INSERT INTO orders (id) VALUES ('x')"), /Task was stopped/);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0]!.token, 'tk_sentinel_session-suite');
	});

	it('retries an idempotent statement once, after re-discovery finds the same endpoint running', async () => {
		const fake = fakeClient(failFirst({ rows: [{ id: 1 }], affected_rows: 0 }));
		const session = createSqlSession(fake.client, endpoint);

		const result = await session.execute('SELECT * FROM orders', { idempotent: true });
		assert.deepEqual(result, { rows: [{ id: 1 }], affected_rows: 0 });
		// Task tokens are deterministic: the restarted task has the SAME token.
		assert.deepEqual(fake.calls.map((c) => c.token), ['tk_sentinel_session-suite', 'tk_sentinel_session-suite']);
	});

	it('does not retry an idempotent statement whose failure carries no restart code', async () => {
		// A real SQL error: same message text a restart might produce, but no code.
		const fake = fakeClient((_call, index) => {
			if (index === 0) throw new Error('TASK_STOPPED: Task was stopped');
			return { rows: [], affected_rows: 0 };
		});
		const session = createSqlSession(fake.client, endpoint);

		await assert.rejects(session.execute('SELECT 1', { idempotent: true }), /Task was stopped/);
		assert.equal(fake.calls.length, 1);
	});

	it('does not retry any other server code', async () => {
		for (const code of ['TASK_NOT_REGISTERED', 'TASK_COMPLETED', 'TASK_AMBIGUOUS']) {
			const fake = fakeClient(failFirst({ rows: [], affected_rows: 0 }));
			const failing = fakeClient(() => { throw stopped('nope', code); });
			await assert.rejects(createSqlSession(failing.client, endpoint).execute('SELECT 1', { idempotent: true }), /nope/);
			assert.equal(failing.calls.length, 1, code);
			assert.equal(fake.calls.length, 0);
		}
	});

	it('forwards bind params and omits the field entirely when there is nothing to bind', async () => {
		const fake = fakeClient(() => ({ rows: [], affected_rows: 0 }));
		const session = createSqlSession(fake.client, endpoint);

		await session.execute('SELECT * FROM t WHERE a = $1', { params: ['x'] });
		await session.execute('SELECT 1', { params: [] });
		await session.execute('SELECT 2');

		assert.deepEqual(fake.calls[0]!.input, { sql: 'SELECT * FROM t WHERE a = $1', params: ['x'] });
		assert.deepEqual(fake.calls[1]!.input, { sql: 'SELECT 1' });
		assert.deepEqual(fake.calls[2]!.input, { sql: 'SELECT 2' });
	});

	it('waits as long as the statement takes: execute has no client timeout (SQL nodes set no deadline)', async () => {
		let timeoutSeen: unknown = 'unset';
		const client = {
			getTasks: async () => currentRows(),
			getTaskPipeline: async () => undefined,
			tool: async (options: { timeout?: number }) => { timeoutSeen = options.timeout; return { rows: [], affected_rows: 0 }; },
		} as unknown as RocketRideClient;
		await createSqlSession(client, endpoint).execute('SELECT 1');
		assert.equal(timeoutSeen, undefined);
	});
});

// =============================================================================
// REFLECTION CALLS — ALWAYS SAFE TO REPEAT
// =============================================================================

describe('reflection retry policy', () => {
	it('retries get_schema and dialect once on a restarted task', async () => {
		for (const run of [
			{ call: (s: ReturnType<typeof createSqlSession>) => s.getSchema(), tool: 'get_schema', result: { tables: {} } },
			{ call: (s: ReturnType<typeof createSqlSession>) => s.dialect(), tool: 'dialect', result: { dialect: 'mysql' } },
		]) {
			const fake = fakeClient(failFirst(run.result));
			await run.call(createSqlSession(fake.client, endpoint));
			assert.deepEqual(fake.calls.map((c) => c.tool), [run.tool, run.tool]);
		}
	});

	it('maps an unrecognised dialect string to unknown', async () => {
		const fake = fakeClient(() => ({ dialect: 'duckdb' }));
		assert.equal(await createSqlSession(fake.client, endpoint).dialect(), 'unknown');
	});

	it('refuses to call when no task is running for the endpoint', async () => {
		resetEndpoints();
		const fake = fakeClient(() => ({}));
		await assert.rejects(createSqlSession(fake.client, endpoint).getSchema(), /No running task/);
		assert.equal(fake.calls.length, 0);
	});
});

// =============================================================================
// REFRESH SCHEMA — FALL BACK ON ANY ERROR, NEVER ON ERROR TEXT
// =============================================================================

describe('refreshSchema fallback', () => {
	it('returns the refresh tool result unflagged when the node has the tool', async () => {
		const fake = fakeClient(() => ({ database: 'shop', tables: { orders: { columns: [] } } }));
		const schema = await createSqlSession(fake.client, endpoint).refreshSchema();
		assert.equal(schema.stale, undefined);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema']);
	});

	it('falls back to get_schema and flags the result stale, whatever the error says', async () => {
		// Three unrelated wordings, one behaviour: no text is inspected.
		for (const message of ['tool.invoke: refresh_schema not owned', 'socket hang up', '']) {
			const fake = fakeClient((call) => {
				if (call.tool === 'refresh_schema') throw new Error(message);
				return { database: 'shop', tables: {} };
			});
			const schema = await createSqlSession(fake.client, endpoint).refreshSchema();
			assert.equal(schema.stale, true);
			assert.equal(schema.database, 'shop');
			// No restart code, so refresh_schema is NOT retried: one attempt, then the fallback.
			assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'get_schema']);
		}
	});

	it('spends the restart retry on refresh_schema before falling back', async () => {
		// The other half of the sequence: a restarting task makes refresh_schema
		// worth repeating, and only the second failure reaches get_schema — so a
		// fallback is never taken on a failure the retry would have fixed.
		const fake = fakeClient((call) => {
			if (call.tool === 'refresh_schema') throw stopped();
			return { database: 'shop', tables: {} };
		});
		const schema = await createSqlSession(fake.client, endpoint).refreshSchema();
		assert.equal(schema.stale, true);
		assert.deepEqual(fake.calls.map((c) => c.tool), ['refresh_schema', 'refresh_schema', 'get_schema']);
	});

	it('surfaces the fallback failure when get_schema fails too', async () => {
		const fake = fakeClient((call) => {
			throw new Error(call.tool === 'get_schema' ? 'reflection is down' : 'no such tool');
		});
		await assert.rejects(createSqlSession(fake.client, endpoint).refreshSchema(), /reflection is down/);
	});
});
