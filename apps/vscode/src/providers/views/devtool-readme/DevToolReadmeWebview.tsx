// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolReadmeWebview — this host's adapter for the shared ToolDetailsView:
 * catalog facts arrive as one `readme:init` seed from the extension host
 * (icons pre-inlined as data: URIs for the webview CSP); Install/Remove go
 * back as messages.
 */

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { ToolDetailsView } from 'shared/tools/core/chrome/ToolDetailsView';
import { useMessaging } from '../hooks/useMessaging';
import type { ReadmeHostToWebview, ReadmeToolInfo, ReadmeWebviewToHost } from '../../types/devToolReadmeTypes';

const statusStyle: CSSProperties = {
	position: 'fixed',
	inset: 0,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	color: 'var(--rr-text-secondary)',
	fontSize: 13,
	fontFamily: 'var(--rr-font-family)',
	backgroundColor: 'var(--rr-bg-default)',
};

const DevToolReadmeWebview: React.FC = () => {
	const [tool, setTool] = useState<ReadmeToolInfo | null>(null);
	const [installed, setInstalled] = useState(false);
	const [connected, setConnected] = useState(false);
	const [seeded, setSeeded] = useState(false);

	const onMessage = useCallback((message: ReadmeHostToWebview) => {
		if (message.type === 'readme:init') {
			setTool(message.payload.tool);
			setInstalled(message.payload.installed);
			setConnected(message.payload.connected);
			setSeeded(true);
		}
	}, []);

	const { sendMessage } = useMessaging<ReadmeWebviewToHost, ReadmeHostToWebview>({ onMessage });

	if (!seeded || !tool) {
		return (
			<div style={statusStyle}>
				{!seeded ? 'Loading…' : connected ? 'This tool is no longer available on the server.' : 'Connect to a RocketRide server to view this tool.'}
			</div>
		);
	}

	return (
		<ToolDetailsView
			tool={{
				id: tool.id,
				name: tool.name,
				...(tool.publisher !== undefined ? { publisher: tool.publisher } : {}),
				...(tool.version !== undefined ? { version: tool.version } : {}),
				...(tool.description !== undefined ? { description: tool.description } : {}),
				...(tool.iconDataUri !== undefined ? { iconUrl: tool.iconDataUri } : {}),
				...(tool.readme !== undefined ? { readme: tool.readme } : {}),
			}}
			installed={installed}
			connected={connected}
			onInstall={() => sendMessage({ type: 'readme:install', appId: tool.id })}
			onRemove={() => sendMessage({ type: 'readme:remove', appId: tool.id })}
		/>
	);
};

export default DevToolReadmeWebview;
