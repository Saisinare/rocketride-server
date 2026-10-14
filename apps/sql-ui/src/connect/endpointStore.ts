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
// CONNECT — ENDPOINT STORE (shared discovery state for App + Sidebar)
// =============================================================================
//
// SQL Explorer's instance of the shared endpoint store
// (shared/explorer/connect/store). The shell mounts the App and Sidebar as
// SIBLINGS, so they cannot share React context; this module-level instance is
// the shared state both sides subscribe to. Task tokens live only inside it.
// =============================================================================

import type { RocketRideClient } from 'shell';
import { createEndpointStore } from 'shared/explorer/connect/store';
import type { IEndpointState } from 'shared/explorer/connect/store';
import { useEndpointState } from 'shared/explorer/react';
import { SINGLE_TOOLS_ROLE } from 'shared/explorer/types';
import { DATABASE_PROVIDERS } from './discovery';
import { SQL_TOOLS } from './tools';

export type { EndpointStatus, IEndpointState } from 'shared/explorer/connect/store';

/** SQL Explorer's endpoint store: one `tools` role, the relational node providers. */
export const sqlEndpoints = createEndpointStore({
	providers: DATABASE_PROVIDERS,
	roles: SINGLE_TOOLS_ROLE,
	tools: SQL_TOOLS,
});

/**
 * Run (or re-run) endpoint discovery. Concurrent calls coalesce: one runs, and
 * calls made while it runs cause exactly one follow-up.
 *
 * @param client - The shell's RocketRide client.
 */
export async function refreshEndpoints(client: RocketRideClient): Promise<void> {
	await sqlEndpoints.refresh(client);
}

/**
 * Subscribe to the endpoint discovery state.
 *
 * Uses `useSyncExternalStore` for tear-free reads in concurrent mode.
 *
 * @returns The current endpoint state snapshot.
 */
export function useSqlEndpoints(): IEndpointState {
	return useEndpointState(sqlEndpoints);
}
