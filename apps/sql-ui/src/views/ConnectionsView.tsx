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
// SQL-UI — CONNECTIONS VIEW (Archetype C landing: discovered database nodes)
// =============================================================================
//
// The page is shared (shared/explorer/components/ConnectionsLanding); this
// gives it SQL Explorer's wording, its endpoint store, and the probe its drawer
// runs (the node's dialect plus a shallow schema summary).
// =============================================================================

import React from 'react';
import type { RocketRideClient } from 'shell';
import { ConnectionsLanding } from 'shared/explorer/components/ConnectionsLanding';
import type { IConnectionsLandingCopy, LandingDrawerProps } from 'shared/explorer/components/ConnectionsLanding';
import type { IDrawerProbeRow } from 'shared/explorer/components/EndpointDrawer';
import type { ISqlEndpoint } from '../connect';
import { probeSqlEndpoint, sqlEndpoints } from '../connect';
import { connectionUri, getDocs } from '../docs';
import { DatabaseIcon } from '../icons';

// =============================================================================
// WORDING
// =============================================================================

/** The page's words. */
const COPY: IConnectionsLandingCopy = {
	title: 'Connections',
	subtitle: 'SQL databases reachable through your running pipelines. A connection binds to a database tool node in a pipeline.',
	loadingTitle: 'Discovering database nodes',
	loadingDescription: 'Scanning your running pipelines for database tool nodes...',
	emptyTitle: 'No database nodes found',
	emptyDescription: 'Start a pipeline containing a database node (MySQL, PostgreSQL, Supabase, ClickHouse, or RocketRide SQL), then refresh.',
	newLabel: 'New Connection',
};

/** The record drawer's words, probe and icon. */
const DRAWER: LandingDrawerProps<ISqlEndpoint> = {
	avatar: <DatabaseIcon />,
	copy: {
		newTitle: 'New Connection',
		subtitle: 'Bind SQL Explorer to a database tool node in a running pipeline',
		noEndpointsOption: 'No database nodes found',
		pickHint: 'Only database nodes inside running pipelines are listed. The pipeline node owns the database credentials. Nothing is entered here.',
	},
	probe: async (client, endpoint) => {
		const result = await probeSqlEndpoint(client as unknown as RocketRideClient, endpoint);
		if (!result.ok) return { ok: false, rows: [], error: result.error };
		const rows: IDrawerProbeRow[] = [{ label: 'Dialect', value: result.dialect }];
		if (result.database !== undefined) rows.push({ label: 'Database', value: result.database });
		if (result.tableCount !== undefined) rows.push({ label: 'Tables', value: String(result.tableCount) });
		return { ok: true, rows };
	},
};

/**
 * Open (or focus) the workbench document for a connection. The endpoint rides
 * as the static document's content payload.
 *
 * @param endpoint - The connection to open.
 */
function openConnection(endpoint: ISqlEndpoint): void {
	getDocs()?.openStaticDocument(connectionUri(endpoint.key), endpoint.nodeName, endpoint);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Landing view: every database tool node discovered in the caller's running
 * pipelines, as connection cards. Clicking a card opens its workbench; the
 * card's Edit action and the add tile open the record drawer to inspect and
 * probe the endpoint first.
 */
export const ConnectionsView: React.FC = () => (
	<ConnectionsLanding<ISqlEndpoint>
		store={sqlEndpoints}
		icon={<DatabaseIcon />}
		onOpen={openConnection}
		copy={COPY}
		drawer={DRAWER}
	/>
);

export default ConnectionsView;
