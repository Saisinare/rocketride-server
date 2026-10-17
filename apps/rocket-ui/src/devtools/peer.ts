// MIT License
//
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
// DEV-TOOL PEER — in-memory frame ↔ sidebar transport, one per tool
// =============================================================================
//
// The DevToolProps.peer contract for THIS host. Both of a tool's mounts
// live in one window, so the transport is a plain pub/sub keyed by app id;
// WHAT is retained, buffered, or summoned is the shell's ONE relay policy
// (createToolRelay) — this file only supplies the transport and the
// delivery scheduling.
//
// Delivery is ASYNCHRONOUS (a fresh macrotask per post), matching the
// webview postMessage semantics tools are written against: a mount that
// posts in reaction to the other mount's message must unwind the stack
// between hops — synchronous delivery turns that mutual reaction into
// direct recursion ("Maximum call stack size exceeded").
// =============================================================================

import { createToolChannel, createToolRelay } from 'shell';
import type { DevToolProps, ToolChannel, ToolRelay } from 'shell';

/** The peer shape handed to both mounts. */
type Peer = DevToolProps['peer'];

/** Per-tool transport state. */
interface Channel {
	frameSubs: Set<(m: unknown) => void>;
	sidebarSubs: Set<(m: unknown) => void>;
	/** The shell's relay policy over this tool's two ends. */
	relay: ToolRelay;
	/** Cached peer objects — stable identities across remounts. */
	framePeer?: Peer;
	sidebarPeer?: Peer;
	/** Cached ToolChannels — one peer subscription each, stable identities. */
	frameChannel?: ToolChannel;
	sidebarChannel?: ToolChannel;
}

const channels = new Map<string, Channel>();

/** Host hook: how to open a tool's frame when a sidebar post finds none. */
let frameOpener: ((appId: string) => void) | null = null;

/**
 * Registers the host's "open the tool frame" action (the document opener).
 * A sidebar post with no mounted frame buffers the message and calls this.
 *
 * @param open - Opens (or focuses) the tool's document; null to clear.
 */
export function setToolFrameOpener(open: ((appId: string) => void) | null): void {
	frameOpener = open;
}

/**
 * Delivers one message to a subscriber set on a FRESH task (see the file
 * header). The set is read at fire time, so a callback unsubscribed while
 * the message was in flight is not called.
 *
 * @param subs - The live subscriber set (frame or sidebar side).
 * @param message - The opaque payload.
 */
function deliver(subs: Set<(m: unknown) => void>, message: unknown): void {
	setTimeout(() => {
		for (const cb of subs) cb(message);
	}, 0);
}

/** The (lazily created) transport for one tool. */
function channel(appId: string): Channel {
	let ch = channels.get(appId);
	if (!ch) {
		const frameSubs = new Set<(m: unknown) => void>();
		const sidebarSubs = new Set<(m: unknown) => void>();
		ch = {
			frameSubs,
			sidebarSubs,
			relay: createToolRelay({
				toFrame: (payload) => deliver(frameSubs, payload),
				toSidebar: (payload) => deliver(sidebarSubs, payload),
				frameLive: () => frameSubs.size > 0,
				sidebarLive: () => sidebarSubs.size > 0,
				summonFrame: () => frameOpener?.(appId),
			}),
		};
		channels.set(appId, ch);
	}
	return ch;
}

/**
 * Replays relay-held payloads to a freshly subscribed callback — async like
 * every delivery, skipped if the callback unsubscribed first.
 *
 * @param subs - The side's subscriber set (liveness check at fire time).
 * @param cb - The new subscriber.
 * @param replay - The relay's replay function for this side.
 */
function replayAsync(subs: Set<(m: unknown) => void>, cb: (m: unknown) => void, replay: (deliver: (payload: unknown) => void) => void): void {
	const payloads: unknown[] = [];
	replay((payload) => payloads.push(payload));
	if (payloads.length === 0) return;
	setTimeout(() => {
		if (!subs.has(cb)) return;
		for (const payload of payloads) cb(payload);
	}, 0);
}

/**
 * The peer handed to a tool's FRAME mount (`tool:<appId>` document).
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The frame-side peer.
 */
export function getFramePeer(appId: string): Peer {
	const ch = channel(appId);
	if (!ch.framePeer) {
		ch.framePeer = {
			post: (message: unknown) => ch.relay.fromFrame(message),
			subscribe: (cb: (message: unknown) => void) => {
				ch.frameSubs.add(cb);
				// Retained channel state first, then buffered events — the
				// relay's canonical replay order for a late frame.
				replayAsync(ch.frameSubs, cb, (d) => ch.relay.replayToFrame(d));
				return () => ch.frameSubs.delete(cb);
			},
		};
	}
	return ch.framePeer;
}

/**
 * The peer handed to a tool's SIDEBAR mount.
 * Stable identity per tool — safe to pass as a React prop across remounts.
 *
 * @param appId - The tool's app id.
 * @returns The sidebar-side peer.
 */
export function getSidebarPeer(appId: string): Peer {
	const ch = channel(appId);
	if (!ch.sidebarPeer) {
		ch.sidebarPeer = {
			post: (message: unknown) => ch.relay.fromSidebar(message),
			subscribe: (cb: (message: unknown) => void) => {
				ch.sidebarSubs.add(cb);
				// The frame's retained last push (+ any buffered payloads).
				replayAsync(ch.sidebarSubs, cb, (d) => ch.relay.replayToSidebar(d));
				return () => ch.sidebarSubs.delete(cb);
			},
		};
	}
	return ch.sidebarPeer;
}

/**
 * The cached ToolChannel for one slot of one tool — built lazily over the
 * slot's peer, stable across remounts (a channel holds one standing peer
 * subscription; minting one per render would stack them).
 *
 * @param appId - The tool's app id.
 * @param slot - Which mount the channel serves.
 * @returns The channel.
 */
export function getToolChannel(appId: string, slot: 'frame' | 'sidebar'): ToolChannel {
	const ch = channel(appId);
	if (slot === 'frame') {
		if (!ch.frameChannel) ch.frameChannel = createToolChannel(getFramePeer(appId));
		return ch.frameChannel;
	}
	if (!ch.sidebarChannel) ch.sidebarChannel = createToolChannel(getSidebarPeer(appId));
	return ch.sidebarChannel;
}
