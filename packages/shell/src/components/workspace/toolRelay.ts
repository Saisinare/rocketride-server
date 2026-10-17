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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOL RELAY — the ONE relay policy between a tool's two mounts
// =============================================================================
//
// Every host relays peer traffic between a tool's frame and sidebar mounts;
// THIS module is the policy, stated once (it used to live rule-for-rule in
// each host, and the copies had already diverged on eviction direction):
//
//   - CALLS (op requests) are live-only toward the sidebar: never retained
//     (a reloaded sidebar must not re-execute them); no live sidebar = drop
//     (the caller's timeout reports it).
//   - REPLIES are live-only toward the frame: never retained, never
//     buffered, never summoning — a reply to a closed caller is dropped.
//   - Channel STATE toward the frame is retained per topic and replayed to
//     late mounts; a state publish never summons a window.
//   - Everything else frame→sidebar: the LAST payload is retained (a
//     remounted sidebar renders without a mount-time handshake) and live
//     delivery is attempted; without a live sidebar the payload also
//     buffers (bounded) for the next attach.
//   - Everything else sidebar→frame (events, raw messages): live delivery,
//     else buffer (bounded) and SUMMON the frame — a sidebar post is a
//     user action by the peer contract.
//   - Buffers evict the OLDEST entry past the cap (newest user intent wins).
//   - Replay order toward a (re)attached frame: retained state first, then
//     the buffered events.
//
// Transport-agnostic and dependency-light (no React, no DOM): browser hosts
// import it off the shell barrel; the VS Code EXTENSION HOST deep-imports
// this module directly (its import chain is plain .ts — see
// toolWorkspaceFs.ts for the precedent). Delivery scheduling (async
// macrotask vs postMessage) stays with the host — the relay only decides
// WHAT is delivered, retained, buffered, or summoned.
// =============================================================================

import { asToolStateMessage } from './toolChannel';
import { asToolCallMessage, asToolReplyMessage } from './toolOps';
import type { IToolStateMessage } from './toolChannel';

/** Wire name of the host connection topic (see toolProtocol.ts for the
 *  tool-facing surface; defined here so non-browser host processes get it
 *  without the React import chain). */
export const HOST_CONNECTION_TOPIC = 'host:connection';

/**
 * The host-published `host:connection` state envelope — the ONE wire shape
 * both in-browser hosts (publishHostConnectionState) and the VS Code
 * extension host deliver.
 *
 * @param connected - Whether the host's server connection is up.
 * @returns The state message.
 */
export function hostConnectionPayload(connected: boolean): IToolStateMessage {
	return { __rrtool: 'state', topic: HOST_CONNECTION_TOPIC, snapshot: { connected } };
}

/** Most buffered payloads kept per direction (oldest evicted past this). */
export const TOOL_RELAY_BUFFER_LIMIT = 64;

/** The host-supplied sides of one tool's relay. */
export interface ToolRelayEnds {
	/** Delivers one payload to the live frame side. Called only while
	 *  {@link frameLive} is true. */
	toFrame(payload: unknown): void;
	/** Delivers one payload to the live sidebar side. Called only while
	 *  {@link sidebarLive} is true. */
	toSidebar(payload: unknown): void;
	/** Whether a frame sink is currently attached. */
	frameLive(): boolean;
	/** Whether a sidebar sink is currently attached. */
	sidebarLive(): boolean;
	/** Opens (or focuses) the tool's frame — a sidebar event found no live
	 *  frame. Hosts without a summon capability omit it. */
	summonFrame?(): void;
}

/** One tool's relay: the policy over the host's two ends. */
export interface ToolRelay {
	/** Routes one frame→sidebar payload per the policy. */
	fromFrame(payload: unknown): void;
	/** Routes one sidebar→frame payload per the policy. */
	fromSidebar(payload: unknown): void;
	/** Replays what a newly attached FRAME must see, in order: retained
	 *  state snapshots, then the buffered events (draining the buffer). */
	replayToFrame(deliver: (payload: unknown) => void): void;
	/** Replays what a newly attached SIDEBAR must see: the retained last
	 *  frame push, then the buffered frame payloads (draining). */
	replayToSidebar(deliver: (payload: unknown) => void): void;
}

/**
 * Builds one tool's relay over the host's ends.
 *
 * @param ends - The host's delivery/liveness/summon surface.
 * @param options - Buffer cap override (tests).
 * @returns The relay.
 */
export function createToolRelay(ends: ToolRelayEnds, options?: { bufferLimit?: number }): ToolRelay {
	const limit = options?.bufferLimit ?? TOOL_RELAY_BUFFER_LIMIT;
	/** Channel STATE toward the frame, retained per topic. */
	const retainedToFrame = new Map<string, unknown>();
	/** Sidebar→frame payloads awaiting a live frame. */
	const bufferToFrame: unknown[] = [];
	/** The LAST non-call frame→sidebar payload (remount replay). */
	let retainedToSidebar: { payload: unknown } | undefined;
	/** Frame→sidebar payloads awaiting a live sidebar. */
	const bufferToSidebar: unknown[] = [];

	const push = (buffer: unknown[], payload: unknown): void => {
		buffer.push(payload);
		if (buffer.length > limit) buffer.shift();
	};

	return {
		fromFrame(payload) {
			// Correlated CALL: live-only — never retained, never buffered.
			if (asToolCallMessage(payload)) {
				if (ends.sidebarLive()) ends.toSidebar(payload);
				return;
			}
			retainedToSidebar = { payload };
			if (ends.sidebarLive()) ends.toSidebar(payload);
			else push(bufferToSidebar, payload);
		},
		fromSidebar(payload) {
			// Correlated REPLY: live-only — a closed caller already gave up.
			if (asToolReplyMessage(payload)) {
				if (ends.frameLive()) ends.toFrame(payload);
				return;
			}
			// Channel STATE: retain per topic; never buffer, never summon.
			const state = asToolStateMessage(payload);
			if (state) {
				retainedToFrame.set(state.topic, payload);
				if (ends.frameLive()) ends.toFrame(payload);
				return;
			}
			// Event / raw message: a user action — deliver or buffer+summon.
			if (ends.frameLive()) {
				ends.toFrame(payload);
				return;
			}
			push(bufferToFrame, payload);
			ends.summonFrame?.();
		},
		replayToFrame(deliver) {
			for (const payload of retainedToFrame.values()) deliver(payload);
			const pending = bufferToFrame.splice(0);
			for (const payload of pending) deliver(payload);
		},
		replayToSidebar(deliver) {
			if (retainedToSidebar) deliver(retainedToSidebar.payload);
			const pending = bufferToSidebar.splice(0);
			for (const payload of pending) deliver(payload);
		},
	};
}
