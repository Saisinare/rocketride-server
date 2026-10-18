// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BUS REALM — this webview as a spoke of the shell bus
// =============================================================================
//
// Attaches the realm's ConnectionManager op bus to the extension host's
// router (toolhost/busHost.ts) over the webview's postMessage channel, and
// receives the broker's MIRROR feed:
//
//   - `mirror.state` — connection/account/services snapshot, re-emitted
//     locally as the shell events realm code already listens for
//     (shell:statusChange / shell:accountUpdate / shell:servicesUpdated),
//   - `mirror.event` — engine pushes (task/status events), re-emitted as
//     `shell:event` so controllers fold them exactly as they folded events
//     off their own socket.
//
// Bus traffic rides the `__rrbus` envelope on the SAME channel as the
// view's typed messages — the view's useMessaging switch never sees it
// (no `type` field), and this module never sees the view's messages.
//
// This file is the realm's ONE bus attachment: call attachSidebarRealm()
// once at module scope. After this lands, the realm needs no socket and no
// authToken — engine access is `request('client.*')`.
// =============================================================================

import { ConnectionManager, attachRealmToRoot } from 'shell';
import type { IBusEndpoint } from 'shell';
import { getVsCodeApi } from '../hooks/useMessaging';

/** The bus envelope key (must match shell busBridge.ts). */
const BUS_ENVELOPE = '__rrbus';

let attached = false;

/**
 * Attaches this realm to the extension host's bus router. Idempotent —
 * the realm has exactly one attachment for its lifetime (a rebooted
 * webview is a fresh realm and attaches fresh).
 */
export function attachSidebarRealm(): void {
	if (attached) return;
	try {
		attachSidebarRealmUnsafe();
	} catch (err) {
		// The bus attach must NEVER take the page down — a realm without a
		// bus degrades (no engine data) but still renders.
		console.error('[busRealm] attach failed:', err);
	}
}

function attachSidebarRealmUnsafe(): void {
	const api = getVsCodeApi();
	if (!api) return; // not inside a VS Code webview (tests, storybook)
	attached = true;

	const endpoint: IBusEndpoint = {
		post: (m) => api.postMessage(m),
		subscribe: (cb) => {
			const listener = (event: MessageEvent): void => {
				const m = event.data as Record<string, unknown> | null;
				if (m && typeof m === 'object' && typeof m[BUS_ENVELOPE] === 'string') cb(m);
			};
			window.addEventListener('message', listener);
			return () => window.removeEventListener('message', listener);
		},
	};

	const cm = ConnectionManager.getInstance();
	attachRealmToRoot(cm.ops(), endpoint);

	// ── Mirror receivers ────────────────────────────────────────────────────
	// Fire-and-forget pushes from the broker, PRIMED into the realm's
	// ConnectionManager: synchronous reads (isConnected, getAccountInfo,
	// getCachedServices) answer from mirrored state, and the matching shell
	// events re-emit locally — consumers written against the ambient manager
	// work unchanged, socketless.
	cm.handle('mirror.state', (params) => {
		cm.primeMirror(params as Parameters<typeof cm.primeMirror>[0]);
	});
	cm.handle('mirror.event', (params) => {
		// Payload shape preserved: shell:event carries { event } (the DAP
		// message), exactly as the socket path produced it.
		cm.emit('shell:event', params as never);
	});

	// Pull the current snapshot once — pushes only cover changes AFTER attach.
	void cm.request('mirror.sync', {}).then(
		(snapshot) => cm.emitOp('mirror.state', snapshot),
		() => { /* root not ready yet — the first broadcast will seed us */ }
	);
}
