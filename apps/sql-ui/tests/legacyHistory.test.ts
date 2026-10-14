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
// LEGACY HISTORY — saved SQL history survives the owner-aware connection key
// =============================================================================
//
// SQL Explorer used to key everything per connection by `projectId:source:nodeId`
// (sql.history, sql.historyRecording, sql.patternChecks). The key now carries
// run kind, owner and team. What users saved under the old key must still be
// read for the connection it meant — the caller's own dev run — and ONLY for
// that one. No automatic write (a run, a pin or note) rewrites the old list;
// the user's own Delete and Clear remove entries from it.
//
// The generic rules are tested in shared/explorer/history; this checks that
// SQL Explorer's own store is wired to them with its own preference keys.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IPrefsApi } from 'shell';
import { attachPrefs, clearForKey, removeEntry, setRecording, togglePin } from '../src/history/historyStore';
import { emitRun } from '../src/history/runEvents';
import type { IHistoryEntry } from '../src/history/types';
import { buildEndpointKey } from 'shared/explorer/keys';

/** Past the store's 300 ms write batch. */
const PAST_THE_BATCH_MS = 500;

/**
 * A fake workspace preferences file; writes round-trip through JSON.
 *
 * @param initial - What it holds.
 * @returns The file and its accessor.
 */
function fakePrefs(initial: Record<string, unknown>): { values: Record<string, unknown>; api: IPrefsApi } {
	const values: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
	return {
		values,
		api: {
			getPref: (key: string) => values[key],
			setPref: (key: string, value: unknown) => { values[key] = JSON.parse(JSON.stringify(value)); },
		} as IPrefsApi,
	};
}

/**
 * Wait for the store's batched write.
 *
 * @returns A promise.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, PAST_THE_BATCH_MS); });
}

/**
 * The two connections of one pipeline: the user's own dev run and the team's deployment.
 *
 * @param name - The project id (distinct per test, because the store is module-level).
 * @returns The keys, old and new.
 */
function keysFor(name: string): { old: string; dev: string; deploy: string } {
	return {
		old: `${name}:tools_1:db_1`,
		dev: buildEndpointKey({ runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't', projectId: name, roles: { tools: 'tools_1' }, nodeId: 'db_1' }),
		deploy: buildEndpointKey({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', teamId: 'team-1', projectId: name, roles: { tools: 'tools_1' }, nodeId: 'db_1' }),
	};
}

const saved = (id: string, sql: string, at: number): Record<string, unknown> => ({ id, sql, at, ms: 4, outcome: 'rows', kind: 'read', rows: 1 });
const entry = (id: string, sql: string, at: number): IHistoryEntry => ({ id, sql, at, ms: 1, outcome: 'rows', rows: 1, kind: 'read' });

describe('SQL history under the owner-aware key', () => {
	it('records a dev run under the NEW key and leaves the list saved under the old key untouched', async () => {
		const keys = keysFor('legacy-a');
		const oldList = [saved('o1', 'SELECT 1', 10)];
		const prefs = fakePrefs({ 'sql.history': { [keys.old]: oldList } });
		const detach = attachPrefs(prefs.api);
		try {
			emitRun(keys.dev, entry('n1', 'SELECT 2', 20));
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string }>>;
			assert.deepEqual(bag[keys.dev]?.map((e) => e.id), ['n1']);
			assert.deepEqual(bag[keys.old], oldList);
		} finally {
			detach();
		}
	});

	it('pins an old entry through a copy under the new key and leaves the old list untouched', async () => {
		const keys = keysFor('legacy-b');
		const oldList = [saved('o1', 'SELECT 1', 10)];
		const prefs = fakePrefs({ 'sql.history': { [keys.old]: oldList } });
		const detach = attachPrefs(prefs.api);
		try {
			togglePin(keys.dev, 'o1');
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string; pinned?: boolean }>>;
			assert.deepEqual(bag[keys.old], oldList);
			assert.deepEqual(bag[keys.dev]?.map((e) => [e.id, e.pinned]), [['o1', true]]);
		} finally {
			detach();
		}
	});

	it('deletes an old entry from the saved old list, and Clear empties it, with no other preference key written', async () => {
		const keys = keysFor('legacy-e');
		const oldList = [saved('o2', 'SELECT 2', 20), saved('o1', 'SELECT 1', 10)];
		const prefs = fakePrefs({ 'sql.history': { [keys.old]: oldList } });
		const detach = attachPrefs(prefs.api);
		try {
			removeEntry(keys.dev, 'o2');
			await settle();
			let bag = prefs.values['sql.history'] as Record<string, unknown[]>;
			assert.deepEqual(bag[keys.old], [oldList[1]]);
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
			clearForKey(keys.dev);
			await settle();
			bag = prefs.values['sql.history'] as Record<string, unknown[]>;
			assert.equal(bag[keys.old], undefined);
			assert.deepEqual(Object.keys(prefs.values).sort(), ['sql.history', 'sql.historyRecording']);
		} finally {
			detach();
		}
	});

	it('inherits a recording switch-OFF saved under the old key, for the dev run only', async () => {
		const keys = keysFor('legacy-c');
		const prefs = fakePrefs({ 'sql.historyRecording': { [keys.old]: false } });
		const detach = attachPrefs(prefs.api);
		try {
			emitRun(keys.dev, entry('d1', 'SELECT card_number FROM payments', 1));
			emitRun(keys.deploy, entry('p1', 'SELECT 1', 2));
			await settle();
			const bag = prefs.values['sql.history'] as Record<string, Array<{ id: string }>> | undefined;
			// The old key's choice not to be recorded still holds for the dev run…
			assert.equal(bag?.[keys.dev], undefined);
			// …and never reaches the team's deployment, which has its own key.
			assert.deepEqual(bag?.[keys.deploy]?.map((e) => e.id), ['p1']);
		} finally {
			detach();
		}
	});

	it('lets the user turn recording back on under the new key without rewriting the old switch', () => {
		const keys = keysFor('legacy-d');
		const prefs = fakePrefs({ 'sql.historyRecording': { [keys.old]: false } });
		const detach = attachPrefs(prefs.api);
		try {
			setRecording(keys.dev, true);
			const flags = prefs.values['sql.historyRecording'] as Record<string, boolean>;
			assert.equal(flags[keys.dev], true);
			assert.equal(flags[keys.old], false);
		} finally {
			detach();
		}
	});
});
