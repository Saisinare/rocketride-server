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
// DEV SESSION REGISTRY — the open apps' dev sessions, found by app id
// =============================================================================

/**
 * Every App Builder document registers its WebDevSession here while it is
 * open, so code outside the document (the agent) can reach the running
 * session for an app. Split panels of one app each hold a session; lookups
 * prefer the one with a preview attached, since only that one builds into a
 * live preview.
 */

import type { WebDevSession } from './devSession';

// =============================================================================
// REGISTRY
// =============================================================================

/** The open sessions, in registration order. */
const sessions = new Set<WebDevSession>();

/**
 * Registers an open session.
 *
 * @param session - The session an App Builder document just created.
 * @returns Unregisters the session; call it when the session is disposed.
 */
export function registerDevSession(session: WebDevSession): () => void {
	sessions.add(session);
	return () => {
		sessions.delete(session);
	};
}

/**
 * The open session for an app, preferring one with a preview attached.
 *
 * @param appId - The app to look up.
 * @returns The session, or null when no document for the app is open.
 */
export function findDevSession(appId: string): WebDevSession | null {
	let first: WebDevSession | null = null;
	for (const session of sessions) {
		if (session.appId !== appId) continue;
		if (session.previewAttached) return session;
		first ??= session;
	}
	return first;
}
