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
// GRAPH-UI - SIDEBAR (navigation menu + the active connection's schema)
// =============================================================================
//
// The stock Explorer tree shows what the schema holds for the active connection:
// node labels and relationship types, each with its properties and observed types.
// Clicking a label or type is the user's request for the 25-row preview, which the
// connection's workbench shows and runs. The status line under the tree says how far
// the schema can be trusted (fresh, sampled, stale, an older format, or unreadable);
// an old node's snapshot is never presented as "the whole graph".
// =============================================================================

import React, { useEffect, useMemo } from 'react';
import { Explorer, NOOP_VFS, SidebarMenu, useShellConnection } from 'shell';
import type { ViewMenu } from 'shell';
import { loadConnectionSchema } from './adapters/actions';
import { workbenchRequests } from './adapters/explorer';
import { useActiveConnection, useGraphEndpoints, useSchema } from './adapters/react';
import { getDocs } from './docs';
import { CONNECTIONS_URI, workbenchUri } from './graph/addresses';
import { SAMPLED_NOTE, schemaStatusText } from './graph/schema';
import { buildSchemaTree } from './graph/schemaTree';
import { GraphIcon } from './icons';

/** Said when the schema listing was cut by the node's own bounds. */
export const TRUNCATED_NOTE = 'The node lists only part of a very large schema.';

/** Props: none. The sidebar reads shared stores, like the other apps' sidebars. */
const GraphSidebar: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const { endpoints, probes } = useGraphEndpoints();
	const activeKey = useActiveConnection();
	const entry = useSchema(activeKey);
	const endpoint = useMemo(() => endpoints.find((e) => e.key === activeKey) ?? null, [endpoints, activeKey]);
	const probe = activeKey ? probes[activeKey] : undefined;
	const tree = useMemo(() => buildSchemaTree(entry.view), [entry.view]);

	// Read the schema once when a connection becomes active and has answered its probe.
	useEffect(() => {
		if (client && isConnected && endpoint && endpoint.state === 'ready' && probe?.ok && entry.status === 'idle') void loadConnectionSchema(client, endpoint);
	}, [client, isConnected, endpoint, probe, entry.status]);

	const menu: ViewMenu = useMemo(
		() => ({
			entries: [{ id: 'connections', label: 'Connections', icon: <GraphIcon />, ...(endpoints.length > 0 ? { count: endpoints.length } : {}) }],
		}),
		[endpoints.length]
	);

	const open = (path: string): void => {
		const target = tree.target(path);
		if (!target || !endpoint) return;
		getDocs()?.openStaticDocument(workbenchUri(endpoint.key), endpoint.nodeName || 'Graph', { endpoint });
		workbenchRequests.request({ endpointKey: endpoint.key, action: target.kind === 'label' ? 'label-preview' : 'type-preview', name: target.name, at: Date.now() });
	};

	const showTree = activeKey !== null && endpoint !== null && (entry.status !== 'idle' || entry.view.labels.length > 0);
	const status = entry.status === 'loading' ? 'Reading the schema\u2026' : schemaStatusText(entry.view, Date.now());

	return (
		<>
			<SidebarMenu menu={menu} activeId={activeKey ? '' : 'connections'} onSelect={() => getDocs()?.openStaticDocument(CONNECTIONS_URI, 'Connections')} sectionLabel="Graph Explorer" />
			{showTree && (
				<>
					<Explorer
						vfs={NOOP_VFS}
						config={{
							title: entry.view.labels.length + entry.view.relationshipTypes.length === 0 ? 'Schema' : endpoint.nodeName || 'Schema',
							extensions: null,
							displayName: (filename) => tree.displayName(filename),
							emptyMessage: entry.status === 'loading' ? 'Reading the schema\u2026' : 'No labels or relationship types listed',
							allowFolders: false,
						}}
						entries={tree.entries}
						isConnected={isConnected}
						onOpenFile={open}
						onRefresh={() => {
							if (client && endpoint) void loadConnectionSchema(client, endpoint, { fresh: true });
						}}
					/>
					<div style={{ padding: '8px 14px', fontSize: 12, lineHeight: 1.45, color: 'var(--rr-text-secondary)' }}>
						<div>{status}</div>
						{entry.failure && entry.failure.headline !== '' && (
							<div style={{ marginTop: 4, color: 'var(--rr-color-warning)' }}>
								{entry.failure.headline}
								{entry.failure.hint ? ` ${entry.failure.hint}` : ''}
							</div>
						)}
						{entry.view.error && entry.view.error.headline !== '' && (
							<div style={{ marginTop: 4 }}>
								<div>{entry.view.error.headline}</div>
								{entry.view.error.detail !== '' && <div style={{ fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.view.error.detail}</div>}
							</div>
						)}
						{entry.view.sampled && entry.view.labels.length > 0 && <div style={{ marginTop: 4 }}>{SAMPLED_NOTE}</div>}
						{entry.view.truncated && <div style={{ marginTop: 4 }}>{TRUNCATED_NOTE}</div>}
						{tree.entries.length > 0 && <div style={{ marginTop: 4 }}>Click a label or type to preview 25 of its rows.</div>}
					</div>
				</>
			)}
		</>
	);
};

export default GraphSidebar;
