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
// IDENTITY SCOPE — what a change of account closes
// =============================================================================
//
// The endpoint store forgets every connection (and its task token) when the
// signed-in user, organization or team changes, or the user signs out. The
// open tabs and the schema snapshots belong to those connections too: a query
// tab still shows the rows it fetched, and the sidebar the schema it read. This
// module closes them on the same rule, so the previous account's results are
// never shown to the next one.
//
// The account is tracked at module level, like the stores it clears, so a
// change made while SQL Explorer was not on screen is still caught on its next
// mount. The rule is the identity fingerprint (shared/explorer/connect/identity):
// user, organization and team; never a token, never a permission list.
// =============================================================================

import type { IConnectionDocsHost } from './docs';
import { closeConnectionDocuments, getDocs } from './docs';
import { clearSchemas } from './schema/schemaStore';

/** Tracks the signed-in account and forgets when it changes. */
export interface IIdentityScope {
	/**
	 * Record the account now signed in.
	 *
	 * The first call only binds. A later call with a different fingerprint,
	 * null (signed out) included, forgets; the same fingerprint again does
	 * nothing.
	 *
	 * @param fingerprint - The identity fingerprint, or null when signed out.
	 * @returns True when it forgot.
	 */
	apply(fingerprint: string | null): boolean;
}

/**
 * Create an identity scope.
 *
 * @param forget - What to drop when the account changes.
 * @returns The scope, bound to no account yet.
 */
export function createIdentityScope(forget: () => void): IIdentityScope {
	let bound = false;
	let current: string | null = null;
	return {
		apply(fingerprint) {
			if (!bound) {
				bound = true;
				current = fingerprint;
				return false;
			}
			if (fingerprint === current) return false;
			current = fingerprint;
			forget();
			return true;
		},
	};
}

/**
 * Drop everything that belongs to the previous account's connections: close
 * every connection-scoped tab (the Connections landing stays) and forget the
 * schema snapshots, cached sessions and schema reads in flight.
 *
 * @param docs - The app's Documents instance, or null when none is mounted.
 */
export function forgetConnectionScope(docs: IConnectionDocsHost | null): void {
	if (docs !== null) closeConnectionDocuments(docs);
	clearSchemas();
}

/** SQL Explorer's identity scope, over the app's own Documents instance. */
export const sqlIdentityScope: IIdentityScope = createIdentityScope(() => forgetConnectionScope(getDocs()));
