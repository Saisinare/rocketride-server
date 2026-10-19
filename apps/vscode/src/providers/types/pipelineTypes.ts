// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Project host/webview protocol — the residual message contract between
 * PipelineProvider (extension host) and the project editor webview. Everything
 * else rides the shell bus (host.pipeline.* ops + retained doc topics); only
 * the subscription-gate pushes and the host-side publish verb remain here.
 * Checkout itself rides the shell bus (client.billing.* ops + host.stripeKey).
 *
 * Pure types only — imported by both the extension host and the webview.
 */

/** All messages the extension host can send to the ProjectWebview. */
export type PipelineHostToWebview =
	// Synthesized LOCALLY from the realm's bus event (mirror.event → the
	// same fold) — no host posts it anymore.
	| { type: 'shell:event'; event: unknown }
	// Subscription gate pushes (the Subscribe overlay opens on these).
	| { type: 'checkout:required' }
	| { type: 'checkout:subscriptionUpdate'; isSubscribed: boolean }
	// Publish is the one deploy verb still host-side (it snapshots the
	// TextDocument); everything else rides client.deploy.* on the bus.
	| { type: 'deploy:actionResult'; requestId: number; error?: string | null };

/** All messages the ProjectWebview can send to the extension host. */
export type PipelineWebviewToHost =
	| { type: 'view:ready' }
	// Publish is the one deploy verb still host-side (see above).
	| { type: 'deploy:publish'; requestId: number; comment?: string; deployTo?: string };
