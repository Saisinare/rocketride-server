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
//   - `mirror.status` / `mirror.account` / `mirror.services` — per-topic
//     state pushes (the services blob never rides a status tick),
//     re-emitted locally as the shell events realm code already listens
//     for (shell:statusChange / shell:accountUpdate / shell:servicesUpdated),
//   - `mirror.event` — engine pushes (task/status events), re-emitted as
//     `shell:event` so controllers fold them exactly as they folded events
//     off their own socket.
//
// Bus traffic rides the `__rrbus` envelope on the SAME channel as any typed
// view messages — a useMessaging switch never sees it (no `type` field),
// and this module never sees the view's messages.
//
// This file is a realm's ONE bus attachment: every webview entry (sidebar
// and each framework page) calls attachBusRealm() once at module scope.
// A realm needs no socket and no authToken — engine access is
// `request('client.*')` against the extension host's broker.
// =============================================================================

import { ConnectionManager, attachRealmToRoot } from 'shell';
import type { IBusEndpoint } from 'shell';
import { getVsCodeApi } from './useMessaging';

/** The bus envelope key (must match shell busBridge.ts). */
const BUS_ENVELOPE = '__rrbus';

let attached = false;

/**
 * Attaches this realm to the extension host's bus router. Idempotent —
 * the realm has exactly one attachment for its lifetime (a rebooted
 * webview is a fresh realm and attaches fresh).
 */
export function attachBusRealm(): void {
	if (attached) return;
	try {
		attachBusRealmUnsafe();
	} catch (err) {
		// The bus attach must NEVER take the page down — a realm without a
		// bus degrades (no engine data) but still renders.
		console.error('[busRealm] attach failed:', err);
	}
}

function attachBusRealmUnsafe(): void {
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
	// Each topic is a partial of the same primeMirror contract; the sync
	// snapshot is their union, so one receiver shape covers all four.
	const prime = (params: unknown): void => {
		cm.primeMirror(params as Parameters<typeof cm.primeMirror>[0]);
	};
	cm.handle('mirror.status', prime);
	cm.handle('mirror.account', prime);
	cm.handle('mirror.services', prime);
	cm.handle('mirror.event', (params) => {
		// Payload shape preserved: shell:event carries { event } (the DAP
		// message), exactly as the socket path produced it.
		cm.emit('shell:event', params as never);
	});

	// Pull the current snapshot once — pushes only cover changes AFTER attach.
	void cm.request('mirror.sync', {}).then(
		(snapshot) => prime(snapshot),
		() => { /* root not ready yet — the first broadcast will seed us */ }
	);
}
