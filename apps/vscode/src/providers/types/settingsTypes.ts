// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SETTINGS / CONNECTION TYPES — Welcome + Settings webview wire vocabulary
// =============================================================================
//
// The connection surface's messages, previously bare-camelCase literals with
// NO union on either end (a missed literal failed silently). Namespaced by
// owning concern per the wire-name convention: `settings:*` (the settings
// lifecycle), `docker:*`, `service:*` (the local engine service), `io:*`
// (long-running install/launch IO), `versions:*`. Both providers and both
// webviews type their traffic with these unions, so a renamed or mistyped
// message breaks the build instead of a flow.
//
// Payload fields are typed loosely (unknown/Record) where the legacy shape
// was never declared — tightening them is incremental and local.
// =============================================================================

/** Host → webview pushes for the Welcome and Settings surfaces. */
export type SettingsHostToWebview =
	| { type: 'settings:loaded'; settings: Record<string, unknown> }
	| { type: 'settings:showMessage'; message: string; kind?: string }
	| { type: 'settings:setFocus'; target: string }
	| { type: 'settings:authError'; message: string }
	| { type: 'settings:subscriptionStatus'; isSubscribed: boolean }
	| { type: 'docker:status'; status: unknown }
	| { type: 'docker:error'; message: string }
	| { type: 'docker:versionsLoaded'; versions: unknown }
	| { type: 'service:status'; status: unknown }
	| { type: 'service:error'; message: string }
	| { type: 'service:needsSudo'; reason?: string }
	| { type: 'service:serverInfo'; info: unknown }
	| { type: 'versions:loaded'; versions: unknown }
	| { type: 'io:progress'; progress: unknown }
	| { type: 'io:result'; result: unknown };

/** Webview → host requests for the Welcome and Settings surfaces. */
export type SettingsWebviewToHost =
	| { type: 'settings:save'; settings: Record<string, unknown> }
	| { type: 'settings:saveAndConnect'; settings: Record<string, unknown> }
	| { type: 'settings:clearCredentials' }
	| { type: 'settings:open' }
	| { type: 'settings:openExternal'; url: string }
	| { type: 'versions:fetch'; prerelease?: boolean }
	| { type: 'service:probeServerInfo' }
	| { type: 'service:sudoPassword'; password: string }
	| { type: 'io:control'; action: string };
