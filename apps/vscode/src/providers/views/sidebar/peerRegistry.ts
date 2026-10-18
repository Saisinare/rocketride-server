// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PEER REGISTRY — the webview end of the host's per-tool relay
// =============================================================================
//
// The DevToolProps.peer contract for tool SIDEBAR mounts in this host. The
// relay POLICY (what is retained, buffered, summoned) runs on the extension
// host (DevToolBridge, shell createToolRelay); this registry is only the
// webview-side terminal: stable peer identities, subscriber fan-out, and a
// hold-for-replay buffer for pushes that land before a mount subscribes
// (the host's retained replay arrives at view:ready, long before any lazy
// mount loads).
//
// NOT the rocket-ui peer (devtools/peer.ts): there both mounts share one
// window, so the relay itself runs in-realm. Here the frame lives in a
// separate panel webview and everything crosses the extension host.
// =============================================================================

import type { DevToolProps } from 'shell';

/** The peer shape handed to a tool's sidebar mount. */
export type SidebarPeer = NonNullable<DevToolProps['peer']>;

/** The registry: stable peers out, host-relayed payloads in. */
export interface PeerRegistry {
	/** The ONE peer for a tool — stable identity for the realm's lifetime
	 *  (mounted sidebars memoize their bridges on it). */
	getPeer(appId: string): SidebarPeer;
	/** Fans a host-relayed frame payload out to the tool's subscribers, or
	 *  holds it for replay when none are mounted yet. */
	deliver(appId: string, payload: unknown): void;
}

/** Held payloads per tool — bounded; oldest evicted, so the latest state
 *  pushes always survive (matches the relay's buffer discipline). */
const MAX_PENDING = 64;

/**
 * Creates the webview-side peer registry.
 *
 * @param post - Sends one sidebar-mount message to the extension host's
 *   relay (which summons the tool's frame panel if none is open).
 * @returns The registry.
 */
export function createPeerRegistry(post: (appId: string, payload: unknown) => void): PeerRegistry {
	const subs = new Map<string, Set<(msg: unknown) => void>>();
	const pending = new Map<string, unknown[]>();
	const peers = new Map<string, SidebarPeer>();

	return {
		getPeer(appId) {
			let peer = peers.get(appId);
			if (!peer) {
				peer = {
					// Sidebar mounts post ONLY on user action (peer contract).
					post: (message: unknown) => post(appId, message),
					subscribe: (cb: (message: unknown) => void) => {
						const set = subs.get(appId) ?? new Set<(msg: unknown) => void>();
						set.add(cb);
						subs.set(appId, set);
						// Replay pushes that arrived before this first subscriber.
						const held = pending.get(appId);
						if (held) {
							pending.delete(appId);
							for (const payload of held) cb(payload);
						}
						return () => { set.delete(cb); };
					},
				};
				peers.set(appId, peer);
			}
			return peer;
		},

		deliver(appId, payload) {
			const set = subs.get(appId);
			if (!set || set.size === 0) {
				const held = pending.get(appId) ?? [];
				held.push(payload);
				if (held.length > MAX_PENDING) held.shift();
				pending.set(appId, held);
				return;
			}
			for (const cb of set) cb(payload);
		},
	};
}
