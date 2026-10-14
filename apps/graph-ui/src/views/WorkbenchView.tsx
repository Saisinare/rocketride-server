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
// GRAPH-UI - WORKBENCH VIEW (browse one connection: Ask, Cypher, results, graph)
// =============================================================================
//
// The browsing document of one connection. Everything here READS: the editor sends
// `read_query`, Ask only previews, a label or type click in the sidebar runs the
// generated 25-row preview, and the graph's expand/connect/path actions are reads.
// Changing data is the write console's job, and exists only where the node allows it.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ContentHeader, EmptyState, useShellConnection } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { announcer, graphEndpoints } from '../adapters/explorer';
import { useGraphEndpoints, useWorkbenchRequest } from '../adapters/react';
import { typePreview, labelPreview, isRefusal } from '../cypher/recipes';
import { CONNECTIONS_URI, writeUri } from '../graph/addresses';
import { connectionView, surfaceGate } from '../graph/connections';
import { canWrite, engineText, parseDialect, targetText } from '../graph/dialect';
import { getDocs } from '../docs';
import { GraphIcon } from '../icons';
import { styles } from '../styles';
import AskBar from '../components/AskBar';
import HistoryPanel from '../components/HistoryPanel';
import RunSurface from '../components/RunSurface';
import { createLoadSlot } from '../graph/loadSlot';

/** A sidebar request older than this when the workbench mounts is not replayed. */
const REQUEST_FRESH_MS = 3000;

/** Props. */
export interface IWorkbenchViewProps {
	endpoint: IExplorerEndpoint;
}

/**
 * The workbench of one connection.
 *
 * @param props - See {@link IWorkbenchViewProps}.
 * @returns The view.
 */
export const WorkbenchView: React.FC<IWorkbenchViewProps> = ({ endpoint }) => {
	const { client } = useShellConnection();
	const { probes } = useGraphEndpoints();
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const view = connectionView(endpoint, probe);
	const writable = canWrite(dialect);
	// A surface that has been on screen stays through a re-probe (see surfaceGate): it pauses instead of unmounting.
	const opened = useRef(false);
	if (view.openable) opened.current = true;
	const gate = surfaceGate(view, opened.current);

	const [historyOpen, setHistoryOpen] = useState(false);
	// One slot for the life of the document: the surface takes each request once (see loadSlot.ts).
	const [slot] = useState(createLoadSlot);
	const [loadSeq, setLoadSeq] = useState(0);
	const gateNow = useRef(gate);
	gateNow.current = gate;
	// A run is asked for only while the surface is on screen and can run it: nothing is queued to run by itself later.
	const put = useCallback((text: string, run: boolean) => {
		const now = gateNow.current;
		const runNow = run && now.mounted && now.paused === null;
		if (run && !runNow) announcer.announce(`The statement was put in the editor but not run. ${now.paused ?? 'This connection cannot be browsed yet.'}`);
		setLoadSeq(slot.put({ text, run: runNow }));
	}, [slot]);

	// No probe yet (opened from a stale link or right after a refresh): ask the node who it is.
	useEffect(() => {
		if (client && !probe && endpoint.state === 'ready') void graphEndpoints.probe(client, endpoint.key);
	}, [client, probe, endpoint.key, endpoint.state]);

	// A click on a label or relationship type in the sidebar: show and run the 25-row preview.
	const request = useWorkbenchRequest();
	const handled = useRef(0);
	useEffect(() => {
		if (!request || request.seq === handled.current || request.endpointKey !== endpoint.key) return;
		handled.current = request.seq;
		if (Date.now() - request.at > REQUEST_FRESH_MS) return;
		if (!dialect) {
			announcer.announce('This connection has not answered yet, so the preview was not run.');
			return;
		}
		const engine = { dialect: dialect.dialect, version: dialect.engineVersion };
		const recipe = request.action === 'label-preview' ? labelPreview(engine, request.name) : typePreview(engine, request.name);
		if (isRefusal(recipe)) {
			announcer.announce(recipe.refusal);
			put(`// ${recipe.refusal}`, false);
			return;
		}
		put(recipe.cypher, true);
	}, [request, endpoint.key, dialect, put]);

	const openWrite = (): void => {
		getDocs()?.openStaticDocument(writeUri(endpoint.key), `${endpoint.nodeName || 'Graph'} (write)`, { endpoint });
	};
	const subtitle = dialect ? [engineText(dialect), targetText(dialect)].filter(Boolean).join(' \u00b7 ') : view.address;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={view.title}
				subtitle={subtitle}
				actions={
					writable ? (
						<Button variant="ghost" onClick={openWrite} title="Open the console that can change data. It asks before it sends a statement that looks like a write.">
							Write console
						</Button>
					) : undefined
				}
			/>
			{gate.mounted ? (
				<div style={{ flex: 1, minHeight: 0 }}>
					<RunSurface
						endpoint={endpoint}
						mode="read"
						paused={gate.paused}
						loadSlot={slot}
						loadSeq={loadSeq}
						topSlot={<AskBar endpoint={endpoint} onPreview={(cypher) => put(cypher, false)} />}
						onOpenHistory={() => setHistoryOpen(true)}
					/>
				</div>
			) : (
				<EmptyState
					icon={<GraphIcon />}
					title={endpoint.state === 'ready' ? 'This connection cannot be browsed yet' : 'This connection is not available'}
					description={view.blocked ?? 'The connection has not answered yet.'}
					action={
						<Button variant="primary" onClick={() => getDocs()?.openStaticDocument(CONNECTIONS_URI, 'Connections')}>
							Open Connections
						</Button>
					}
				/>
			)}
			<HistoryPanel
				endpointKey={endpoint.key}
				nodeName={view.title}
				open={historyOpen}
				onClose={() => setHistoryOpen(false)}
				onLoad={(cypher) => {
					put(cypher, false);
					setHistoryOpen(false);
				}}
				onRerun={(cypher) => {
					put(cypher, true);
					setHistoryOpen(false);
				}}
				announce={(text) => announcer.announce(text)}
			/>
		</div>
	);
};

export default WorkbenchView;
