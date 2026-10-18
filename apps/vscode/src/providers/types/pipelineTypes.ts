// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Project host/webview protocol — the message contract between
 * ProjectProvider (extension host) and the project editor webview. Composes
 * the shell base (shellTypes.ts) and the deploy / run-log domain protocols
 * (deployTypes.ts, logTypes.ts); the subscription-gate pushes are
 * Project-only and declared here. Checkout itself rides the shell bus
 * (client.billing.* ops + host.stripeKey) — no checkout requests here.
 *
 * Pure types only — imported by both the extension host and the webview
 * (ViewState/TaskStatus come from the pure `shared/tools/pipelines/project/types`
 * leaf, never the tsx barrel).
 */

import type { ViewState, TaskStatus } from 'shared/tools/pipelines/project/types';
import type { ShellHostToWebview, ShellWebviewToHost } from './shellTypes';

/** All messages the extension host can send to the ProjectWebview. */
export type PipelineHostToWebview =
	| ShellHostToWebview
	| { type: 'project:load'; project: any; viewState: ViewState; prefs: Record<string, unknown>; services: Record<string, any>; icons?: Record<string, string>; isConnected: boolean; cloudConnectionConfigured?: boolean; isSubscribed?: boolean; statuses?: Record<string, TaskStatus>; serverHost?: string; oauthReturnUrl?: string; isReadonly?: boolean; envKeys?: string[] }
	| { type: 'project:oauthTokens'; tokens: string; state: string }
	| { type: 'project:update'; project: any }
	| { type: 'pipeline:init'; doc: string }
	| { type: 'project:dirtyState'; isDirty: boolean; isNew: boolean }
	| { type: 'project:initialPrefs'; prefs: Record<string, unknown> }
	// Subscription gate pushes (the Subscribe overlay opens on these).
	| { type: 'checkout:required' }
	| { type: 'checkout:subscriptionUpdate'; isSubscribed: boolean }
	// Publish is the one deploy verb still host-side (it snapshots the
	// TextDocument); everything else rides client.deploy.* on the bus.
	| { type: 'deploy:actionResult'; requestId: number; error?: string | null };

/** All messages the ProjectWebview can send to the extension host. */
export type PipelineWebviewToHost =
	| ShellWebviewToHost
	| { type: 'project:contentChanged'; project: any }
	| { type: 'project:viewStateChange'; viewState: ViewState }
	| { type: 'project:prefsChange'; prefs: Record<string, unknown> }
	| { type: 'project:openExternal'; url: string }
	// Publish is the one deploy verb still host-side (see above).
	| { type: 'deploy:publish'; requestId: number; comment?: string; deployTo?: string };
