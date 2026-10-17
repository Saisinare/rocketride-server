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
// DEV-TOOL BRIDGE — webview transport for the shell's tool relay
// =============================================================================
//
// The extension host's transport between a tool's sidebar mount (the one
// sidebar webview) and its frame panels (one webview per document). WHAT is
// retained, buffered, or summoned is the shell's ONE relay policy
// (createToolRelay, deep-imported — its import chain is plain .ts, so the
// extension host types against it without the shell's React barrel); this
// class only supplies the per-app sinks and the host-published
// `host:connection` seed every registering panel receives FIRST.
// =============================================================================

// Deep leaf imports: the extension host must not pull the shell's React
// barrel; the relay policy and wire shapes live in dependency-light modules.
import { createToolRelay, hostConnectionPayload } from 'shell/src/components/workspace/toolRelay';
import type { ToolRelay } from 'shell/src/components/workspace/toolRelay';

type Deliver = (payload: unknown) => void;

/** One tool's transport state. */
interface AppEntry {
	relay: ToolRelay;
	/** Live panel delivery functions (one per open document of the tool —
	 *  sidebar→panel payloads broadcast to all; payloads carry whatever the
	 *  tool needs to route). */
	sinks: Set<Deliver>;
}

export class DevToolBridge {
	/**
	 * Called when a sidebar mount posts to a tool whose panel is NOT open —
	 * the host wires this to reopen the panel (the message waits in the
	 * relay's buffer and flushes once the reopened panel registers). The
	 * sidebar outlives the panel, so a click there is an implicit "open".
	 */
	public onPanelNeeded?: (appId: string) => void;

	private apps = new Map<string, AppEntry>();

	/** The (single) sidebar delivery function, once the sidebar resolves. */
	private sidebarSink: ((appId: string, payload: unknown) => void) | null = null;

	/** The host's server reachability — the `host:connection` topic's source
	 *  of truth (the HOST owns this topic; no tool publishes it). */
	private hostConnected = false;

	/** The (lazily created) entry for one tool. */
	private app(appId: string): AppEntry {
		let entry = this.apps.get(appId);
		if (!entry) {
			const sinks = new Set<Deliver>();
			entry = {
				sinks,
				relay: createToolRelay({
					toFrame: (payload) => { for (const sink of sinks) sink(payload); },
					toSidebar: (payload) => this.sidebarSink?.(appId, payload),
					frameLive: () => sinks.size > 0,
					sidebarLive: () => this.sidebarSink !== null,
					summonFrame: () => this.onPanelNeeded?.(appId),
				}),
			};
			this.apps.set(appId, entry);
		}
		return entry;
	}

	/**
	 * Updates the host's server reachability and broadcasts the
	 * `host:connection` state topic to every open tool panel.
	 *
	 * @param connected - Whether the server connection is up.
	 */
	public setHostConnected(connected: boolean): void {
		if (this.hostConnected === connected) return;
		this.hostConnected = connected;
		const payload = hostConnectionPayload(connected);
		for (const entry of this.apps.values()) {
			for (const sink of entry.sinks) sink(payload);
		}
	}

	// ── Panel side ───────────────────────────────────────────────────────────

	/**
	 * Registers a tool panel's delivery function and replays what a fresh
	 * frame must see: the host's `host:connection` FIRST (a restored editor
	 * panel must read correctly before the tool's sidebar ever runs), then
	 * the relay's canonical replay (retained state, then buffered events).
	 *
	 * @param appId - The tool's app id.
	 * @param deliver - Posts one peer payload into the panel webview.
	 */
	public registerPanel(appId: string, deliver: Deliver): void {
		const entry = this.app(appId);
		entry.sinks.add(deliver);
		deliver(hostConnectionPayload(this.hostConnected));
		entry.relay.replayToFrame(deliver);
	}

	/**
	 * Unregisters one disposed tool panel (its sink specifically — other
	 * panels of the same tool keep theirs).
	 *
	 * @param appId - The tool's app id.
	 * @param deliver - The sink registerPanel was given.
	 */
	public unregisterPanel(appId: string, deliver: Deliver): void {
		this.apps.get(appId)?.sinks.delete(deliver);
	}

	/**
	 * Routes a sidebar→panel peer message per the relay policy (live
	 * delivery, state retention, bounded buffering + summon).
	 *
	 * @param appId - The tool's app id.
	 * @param payload - Opaque message payload.
	 */
	public toPanel(appId: string, payload: unknown): void {
		this.app(appId).relay.fromSidebar(payload);
	}

	// ── Sidebar side ─────────────────────────────────────────────────────────

	/**
	 * Registers the sidebar's delivery function. Replay of retained/buffered
	 * payloads waits for {@link replayRetainedToSidebar} — registration
	 * happens before the webview's document loads, when posts can be lost.
	 *
	 * @param deliver - Posts one peer payload (with its tool id) into the sidebar webview.
	 */
	public registerSidebar(deliver: (appId: string, payload: unknown) => void): void {
		this.sidebarSink = deliver;
	}

	/**
	 * Routes a panel→sidebar peer message per the relay policy (live-only
	 * calls, retained last push, bounded buffering).
	 *
	 * @param appId - The tool's app id.
	 * @param payload - Opaque message payload.
	 */
	public toSidebar(appId: string, payload: unknown): void {
		this.app(appId).relay.fromFrame(payload);
	}

	/**
	 * Replays each tool's retained last frame push (plus anything buffered
	 * while the sidebar was away) into the sidebar. The host calls this on
	 * the sidebar webview's `view:ready`.
	 */
	public replayRetainedToSidebar(): void {
		const sink = this.sidebarSink;
		if (!sink) return;
		for (const [appId, entry] of this.apps) {
			entry.relay.replayToSidebar((payload) => sink(appId, payload));
		}
	}
}
