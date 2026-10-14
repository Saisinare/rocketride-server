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
// GRAPH-UI - CONNECTIONS VIEW (the landing page: discovered graph nodes)
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Banner, Button, ConnectionCard, ContentHeader, EmptyState, useShellConnection } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { graphEndpoints } from '../adapters/explorer';
import { useGraphEndpoints } from '../adapters/react';
import ConnectionDrawer from '../components/ConnectionDrawer';
import { getDocs } from '../docs';
import { connectionView, drawerKeyAfter, landingView } from '../graph/connections';
import { workbenchUri } from '../graph/addresses';
import { GraphIcon } from '../icons';
import { styles } from '../styles';

/**
 * The landing view: every graph node found in the caller's running pipelines, as
 * cards. A card opens its drawer; the drawer opens the workbench.
 *
 * @returns The view.
 */
export const ConnectionsView: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const { status, endpoints, probes, error } = useGraphEndpoints();
	const [drawerKey, setDrawerKey] = useState<string | null>(null);

	// First discovery as soon as the shell connection is live.
	useEffect(() => {
		if (client && isConnected && status === 'idle') void graphEndpoints.refresh(client);
	}, [client, isConnected, status]);

	// A sign-out or a change of identity resets the store: the drawer closes with the connections it forgot.
	useEffect(() => {
		const next = drawerKeyAfter(drawerKey, endpoints);
		if (next !== drawerKey) setDrawerKey(next);
	}, [drawerKey, endpoints]);

	const open = (endpoint: IExplorerEndpoint): void => {
		getDocs()?.openStaticDocument(workbenchUri(endpoint.key), endpoint.nodeName || 'Graph', { endpoint });
	};
	const drawerEndpoint = endpoints.find((e) => e.key === drawerKey) ?? null;
	// The cards stay whenever there are any (a message sits above them); the empty state stands alone only without cards.
	const landing = landingView(status, endpoints, error);
	const messageText = landing.message ? [landing.message.description, landing.message.unknown].filter(Boolean).join(' ') : '';

	return (
		<div style={styles.root}>
			<ContentHeader
				title="Connections"
				subtitle="Graph databases reachable through your running pipelines (Apache AGE, Neo4j, FalkorDB). A connection is a graph node in a pipeline."
				actions={
					<Button variant="ghost" onClick={() => { if (client) void graphEndpoints.refresh(client); }} disabled={!client || status === 'loading'}>
						{status === 'loading' ? 'Refreshing...' : 'Refresh'}
					</Button>
				}
			/>
			<div style={styles.content}>
				{status === 'error' && endpoints.length > 0 && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant="error">Refresh failed: {error}. Showing what was found before.</Banner>
					</div>
				)}
				{landing.message && !landing.cards && (
					<EmptyState
						icon={<GraphIcon />}
						title={landing.message.title}
						description={messageText}
						action={landing.message.kind === 'loading' ? undefined : <Button variant="primary" onClick={() => { if (client) void graphEndpoints.refresh(client); }} disabled={!client}>Refresh</Button>}
					/>
				)}
				{landing.message && landing.cards && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant={landing.message.kind === 'loading' ? 'info' : 'warning'}>{`${landing.message.title}. ${messageText}`}</Banner>
					</div>
				)}
				{landing.cards && (
					<div style={styles.cardGrid}>
						{endpoints.map((endpoint) => {
							const view = connectionView(endpoint, probes[endpoint.key]);
							return (
								<ConnectionCard
									key={endpoint.key}
									icon={<GraphIcon />}
									name={view.title}
									address={view.address}
									status={view.badge.variant === 'warning' ? 'muted' : view.badge.variant}
									statusLabel={view.badge.label}
									connected={endpoint.state === 'ready'}
									onClick={() => setDrawerKey(endpoint.key)}
								/>
							);
						})}
					</div>
				)}
			</div>
			<ConnectionDrawer
				key={drawerKey ?? ''}
				open={drawerEndpoint !== null}
				endpoint={drawerEndpoint}
				probe={drawerEndpoint ? probes[drawerEndpoint.key] : undefined}
				onTest={(endpoint) => (client ? graphEndpoints.probe(client, endpoint.key) : Promise.resolve(null))}
				onOpen={(endpoint) => {
					setDrawerKey(null);
					open(endpoint);
				}}
				onClose={() => setDrawerKey(null)}
			/>
		</div>
	);
};

export default ConnectionsView;
