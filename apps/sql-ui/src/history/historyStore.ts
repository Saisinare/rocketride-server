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
// HISTORY STORE — per-connection statement history (App + Sidebar shared state)
// =============================================================================
//
// SQL Explorer's instance of the shared history store
// (shared/explorer/history/store — read that file for WHERE A WRITE LANDS and
// why the recording switch writes through). This module fixes the three
// things that are SQL Explorer's alone and must never change, because renaming
// any of them silently orphans users' saved history:
//
//   - the preference keys `sql.history` and `sql.historyRecording`
//   - the `sql` field of a persisted entry
//   - the bounds (100 entries, 8 KiB of statement, 1 KiB of error)
// =============================================================================

import { createHistoryStore } from 'shared/explorer/history/store';
import { createHistoryPrefsBridge } from 'shared/explorer/react';
import type { IHistoryEntry } from './types';
import { DEFAULT_HISTORY_LIMITS } from './trim';
import { sqlRunEvents } from './runEvents';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Preference key holding every connection's entries. */
const PREF_HISTORY = 'sql.history';

/** Preference key holding the per-connection recording switch. */
const PREF_RECORDING = 'sql.historyRecording';

// =============================================================================
// THE STORE
// =============================================================================

const store = createHistoryStore<'sql'>({
	historyKey: PREF_HISTORY,
	recordingKey: PREF_RECORDING,
	textField: 'sql',
	limits: {
		maxEntries: DEFAULT_HISTORY_LIMITS.maxEntries,
		maxTextChars: DEFAULT_HISTORY_LIMITS.maxSqlChars,
		maxErrorChars: DEFAULT_HISTORY_LIMITS.maxErrorChars,
	},
	runs: sqlRunEvents,
});

/**
 * Attach the shell's preference accessor and hydrate from it.
 *
 * Exported because it is the store's real seam onto the shell:
 * {@link HistoryPrefsBridge} is a null-rendering wrapper around this call, and
 * the persistence rules worth testing (what a hydrate trusts, what a detach
 * drops) live in the store rather than in React.
 */
export const attachPrefs = store.attachPrefs;

/** Forget one entry. */
export const removeEntry = store.removeEntry;

/** Flip one entry's pinned state. */
export const togglePin = store.togglePin;

/** Set (or clear, with '') one entry's note. */
export const setNote = store.setNote;

/** Forget every entry for one connection, pinned entries included. */
export const clearForKey = store.clearForKey;

/**
 * Turn recording on or off for one connection. Existing entries are kept
 * either way — switching off stops new records, it does not erase old ones.
 */
export const setRecording = store.setRecording;

/**
 * Subscribe to one connection's history.
 *
 * @param key - The connection's endpoint key.
 * @returns The entries, newest first (empty for an unknown connection).
 */
export function useHistory(key: string): IHistoryEntry[] {
	return store.useHistory(key) as IHistoryEntry[];
}

/**
 * Subscribe to one connection's recording switch (default on).
 *
 * @param key - The connection's endpoint key.
 * @returns Whether runs on that connection are being recorded.
 */
export const useRecording = store.useRecording;

/**
 * Mounts the store's access to workspace preferences.
 *
 * Renders nothing. Mount it wherever SQL Explorer is on screen and history
 * should be kept — the connection workbench does, and the History drawer
 * mounts its own so the drawer works even from a query document whose
 * workbench tab was closed. Multiple mounts are safe.
 */
export const HistoryPrefsBridge = createHistoryPrefsBridge(store);
