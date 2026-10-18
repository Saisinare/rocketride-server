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
// BUS BRIDGE — one bus across realms, the framework root as the hub
// =============================================================================
//
// Host-agnostic: a host supplies only TRANSPORT ENDPOINTS (a post/subscribe
// pair — webview postMessage in VS Code, in-process dispatch wherever both
// sides share a window). Everything else — correlation, routing, summon —
// is this file, identical in every host.
//
// Topology is hub-and-spoke. Each non-root realm attaches its op bus to the
// root through one endpoint (`attachRealmToRoot`). The root runs the router
// (`createBusRouter`): an incoming request resolves ordered —
//
//   1. the root's OWN handlers (the framework registers `client.*` here),
//   2. another realm that REGISTERED the op (tool controllers),
//   3. the SUMMON table (an installed-but-dormant owner is activated, the
//      message waits for its registration),
//   4. reject — explicitly, back to the caller. No silent drops, and
//      requests are NEVER retained.
//
// Correlation tables exist exactly where a transport is crossed: one in the
// realm bridge (its outbound requests), one per hop in the router (requests
// it forwards to a realm). Each entry dies one of three ways: response,
// timeout, or the handling realm dying (endpoint disposal rejects every
// in-flight entry against it and clears its registrations).
//
// EVENTS DO NOT CROSS HERE. `emit('ns:event')` stays realm-local by design;
// the broker PUSHES specific mirror topics into realms as part of its job
// (those arrive as ordinary local emits). There is no general event
// bridging — forwarding exists only where a handler explicitly does it.
// =============================================================================

import type { IBusForwarder, IOpBus } from './busOps';
import { BusNoHandlerError } from './busOps';

/** The envelope key (coexists with other traffic on a shared transport). */
const ENVELOPE = '__rrbus';

/** How long a summoned owner gets to register before waiting requests fail. */
export const DEFAULT_SUMMON_TIMEOUT_MS = 30_000;

/** Fire-and-forget ops held for a summoned owner — small, oldest-evicted. */
const MAX_SUMMON_BUFFER = 64;

// =============================================================================
// WIRE
// =============================================================================

/** A correlated request crossing a transport. */
interface IBusRequestMessage {
	[ENVELOPE]: 'request';
	id: string;
	op: string;
	params?: unknown;
	/** Remaining budget — the receiving side races its own timer so a dead
	 *  transport can't hold the caller past its deadline. */
	timeoutMs: number;
}

/** A correlated response. */
interface IBusResponseMessage {
	[ENVELOPE]: 'response';
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** A fire-and-forget op invocation. */
interface IBusEmitOpMessage {
	[ENVELOPE]: 'emitOp';
	op: string;
	params?: unknown;
}

/** Registration announcements (realm → root only). */
interface IBusRegisterMessage {
	[ENVELOPE]: 'register' | 'unregister';
	ops: string[];
}

type BusWireMessage = IBusRequestMessage | IBusResponseMessage | IBusEmitOpMessage | IBusRegisterMessage;

/** Narrows an arbitrary transport payload to bus traffic. */
function asBusMessage(message: unknown): BusWireMessage | null {
	const m = message as BusWireMessage | null;
	return m && typeof m === 'object' && typeof (m as unknown as Record<string, unknown>)[ENVELOPE] === 'string' ? m : null;
}

// =============================================================================
// ENDPOINT — the ONLY thing a host supplies
// =============================================================================

/** One side of a transport between two realms. */
export interface IBusEndpoint {
	/** Sends one message to the other side. */
	post(message: unknown): void;
	/** Subscribes to messages from the other side; returns unsubscribe. */
	subscribe(cb: (message: unknown) => void): () => void;
}

// =============================================================================
// REALM SIDE
// =============================================================================

/**
 * Attaches a realm's op bus to the framework root over one endpoint.
 *
 * Outbound: unresolved requests/emitOps forward to the root; local
 * registrations are announced (including ones made before attach — the bus
 * replays them into the forwarder). Inbound: requests from the root (ops
 * THIS realm registered) run against local handlers and answer by id.
 *
 * @param bus - This realm's op bus.
 * @param endpoint - Transport to the root.
 * @returns Detach function (rejects this realm's in-flight outbound requests).
 */
export function attachRealmToRoot(bus: IOpBus, endpoint: IBusEndpoint): () => void {
	let seq = 0;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	const forwarder: IBusForwarder = {
		request(op, params, timeoutMs) {
			return new Promise((resolve, reject) => {
				const id = `r${++seq}`;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Op '${op}' timed out after ${timeoutMs}ms (bridged)`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				endpoint.post({ [ENVELOPE]: 'request', id, op, params, timeoutMs } satisfies IBusRequestMessage);
			});
		},
		emitOp(op, params) {
			endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
		},
		register(op) {
			endpoint.post({ [ENVELOPE]: 'register', ops: [op] } satisfies IBusRegisterMessage);
		},
		unregister(op) {
			endpoint.post({ [ENVELOPE]: 'unregister', ops: [op] } satisfies IBusRegisterMessage);
		},
	};

	const unsubscribe = endpoint.subscribe((message) => {
		const m = asBusMessage(message);
		if (!m) return;
		switch (m[ENVELOPE]) {
			case 'response': {
				const entry = pending.get(m.id);
				if (!entry) return; // caller timed out / duplicate — drop silently
				pending.delete(m.id);
				clearTimeout(entry.timer);
				if (m.ok) entry.resolve(m.result);
				else entry.reject(new Error(m.error ?? `Op failed at the root`));
				break;
			}
			case 'request': {
				// The root routed an op THIS realm registered. Answer by id.
				// hasHandler guard: a just-unregistered op answers with the
				// no-handler error instead of hanging the caller.
				if (!bus.hasHandler(m.op)) {
					endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: false, error: new BusNoHandlerError(m.op).message } satisfies IBusResponseMessage);
					return;
				}
				bus.request(m.op, m.params, { timeoutMs: m.timeoutMs }).then(
					(result) => endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: true, result } satisfies IBusResponseMessage),
					(err: unknown) => endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies IBusResponseMessage)
				);
				break;
			}
			case 'emitOp':
				if (bus.hasHandler(m.op)) bus.emitOp(m.op, m.params);
				break;
			// register/unregister never arrive realm-side (root-only concern).
		}
	});

	bus.setForwarder(forwarder);

	return () => {
		bus.setForwarder(null);
		unsubscribe();
		for (const [, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error('Bus bridge detached'));
		}
		pending.clear();
	};
}

// =============================================================================
// ROOT SIDE — the router
// =============================================================================

/** Summon lookup: an activation thunk when the op's owner is INSTALLED but
 *  not yet registered, null otherwise. Installed-only is the caller's
 *  contract (pinned store tools + enabled builtins); summon NEVER installs. */
export type SummonLookup = (op: string) => (() => void) | null;

/** Router options. */
export interface IBusRouterOptions {
	/** The summon table (see {@link SummonLookup}). Absent = no summoning. */
	summon?: SummonLookup;
	/** How long a summoned owner gets to register. */
	summonTimeoutMs?: number;
}

/** The framework root's router. */
export interface IBusRouter {
	/**
	 * Attaches one realm. Returns a detach function — detaching clears the
	 * realm's registrations and rejects every in-flight request routed to it.
	 *
	 * @param endpoint - Transport to the realm.
	 * @param label - For diagnostics ('sidebar', 'page:account', ...).
	 */
	addRealm(endpoint: IBusEndpoint, label: string): () => void;
	/**
	 * Pushes one fire-and-forget op to EVERY attached realm — the broker's
	 * mirror feed (connection/account/services state into each realm's local
	 * bus). Realms that registered no handler for the op drop it silently;
	 * this is the ONE root→all path, outside the registration routing.
	 */
	broadcastEmitOp(op: string, params: unknown): void;
	/** Disposes every realm attachment. */
	dispose(): void;
}

/**
 * Creates the router over the ROOT's own op bus. The root's bus gets a
 * forwarder too, so root-initiated requests reach realm-registered ops
 * through the same resolution path.
 *
 * @param rootBus - The framework root's op bus (the broker registers here).
 * @param options - Summon configuration.
 * @returns The router.
 */
export function createBusRouter(rootBus: IOpBus, options?: IBusRouterOptions): IBusRouter {
	const summonTimeoutMs = options?.summonTimeoutMs ?? DEFAULT_SUMMON_TIMEOUT_MS;

	interface IRealm {
		endpoint: IBusEndpoint;
		label: string;
		ops: Set<string>;
		/** Requests this router forwarded INTO the realm, by hop id. */
		inflight: Map<string, { respond: (m: IBusResponseMessage) => void; timer: ReturnType<typeof setTimeout> }>;
		unsubscribe: () => void;
	}

	const realms = new Set<IRealm>();
	const opOwners = new Map<string, IRealm>();
	let hopSeq = 0;
	let disposed = false;

	/** Fire-and-forget ops waiting on a summoned owner, per op name. */
	const summonBuffers = new Map<string, unknown[]>();
	/** Ops with an activation already fired (dedupe repeated summons). */
	const summonsInFlight = new Set<string>();

	/** Resolves one request wherever its handler lives; answers via respond. */
	const routeRequest = (op: string, params: unknown, timeoutMs: number, respond: (m: IBusResponseMessage) => void, mintId: () => string): void => {
		// 1. The root's own handlers (client.* broker, host verbs).
		if (rootBus.hasHandler(op)) {
			rootBus.request(op, params, { timeoutMs }).then(
				(result) => respond({ [ENVELOPE]: 'response', id: '', ok: true, result }),
				(err: unknown) => respond({ [ENVELOPE]: 'response', id: '', ok: false, error: err instanceof Error ? err.message : String(err) })
			);
			return;
		}
		// 2. A realm that registered the op.
		const owner = opOwners.get(op);
		if (owner) {
			const hopId = mintId();
			const timer = setTimeout(() => {
				owner.inflight.delete(hopId);
				respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Op '${op}' timed out after ${timeoutMs}ms (routed to ${owner.label})` });
			}, timeoutMs);
			owner.inflight.set(hopId, { respond, timer });
			owner.endpoint.post({ [ENVELOPE]: 'request', id: hopId, op, params, timeoutMs } satisfies IBusRequestMessage);
			return;
		}
		// 3. Summon an installed-but-dormant owner, then retry on register.
		const activate = options?.summon?.(op);
		if (activate) {
			const started = Date.now();
			if (!summonsInFlight.has(op)) {
				summonsInFlight.add(op);
				try {
					activate();
				} catch (err) {
					summonsInFlight.delete(op);
					respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Summon for '${op}' failed: ${err instanceof Error ? err.message : String(err)}` });
					return;
				}
			}
			// Poll-free wait: watch registrations arriving from any realm.
			const giveUp = setTimeout(() => {
				cleanup();
				respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Op '${op}' owner did not register within ${summonTimeoutMs}ms of summon` });
			}, Math.min(summonTimeoutMs, timeoutMs));
			const cleanup = registerWaiters(op, () => {
				clearTimeout(giveUp);
				const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
				routeRequest(op, params, remaining, respond, mintId);
			});
			return;
		}
		// 4. Reject — explicitly, never silently.
		respond({ [ENVELOPE]: 'response', id: '', ok: false, error: new BusNoHandlerError(op).message });
	};

	/** One-shot waiters per op for summon completion. */
	const opWaiters = new Map<string, Set<() => void>>();
	const registerWaiters = (op: string, cb: () => void): (() => void) => {
		const set = opWaiters.get(op) ?? new Set<() => void>();
		set.add(cb);
		opWaiters.set(op, set);
		return () => set.delete(cb);
	};
	const fireWaiters = (op: string): void => {
		summonsInFlight.delete(op);
		const set = opWaiters.get(op);
		if (set) {
			opWaiters.delete(op);
			for (const cb of set) cb();
		}
		// Deliver fire-and-forget ops held for the summoned owner.
		const held = summonBuffers.get(op);
		if (held) {
			summonBuffers.delete(op);
			for (const params of held) routeEmitOp(op, params);
		}
	};

	/** Fire-and-forget routing: root handler → owner realm → summon-buffer → drop. */
	const routeEmitOp = (op: string, params: unknown): void => {
		if (rootBus.hasHandler(op)) {
			rootBus.emitOp(op, params);
			return;
		}
		const owner = opOwners.get(op);
		if (owner) {
			owner.endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
			return;
		}
		const activate = options?.summon?.(op);
		if (activate) {
			const held = summonBuffers.get(op) ?? [];
			held.push(params);
			if (held.length > MAX_SUMMON_BUFFER) held.shift();
			summonBuffers.set(op, held);
			if (!summonsInFlight.has(op)) {
				summonsInFlight.add(op);
				try {
					activate();
				} catch (err) {
					summonsInFlight.delete(op);
					summonBuffers.delete(op);
					console.error(`[BusRouter] summon for emitOp '${op}' failed:`, err);
				}
			}
			return;
		}
		console.debug(`[BusRouter] emitOp '${op}' dropped — no handler, not summonable`);
	};

	// Root-initiated traffic resolves through the same router paths.
	rootBus.setForwarder({
		request: (op, params, timeoutMs) =>
			new Promise((resolve, reject) => {
				routeRequest(op, params, timeoutMs, (m) => {
					if (m.ok) resolve(m.result);
					else reject(new Error(m.error ?? `Op '${op}' failed`));
				}, () => `h${++hopSeq}`);
			}),
		emitOp: (op, params) => routeEmitOp(op, params),
		register: () => { /* root registrations are local by definition */ },
		unregister: () => { /* ditto */ },
	});
	// Root-side registrations can complete a summon wait.
	rootBus.onRegistrationChange((op, registered) => {
		if (registered) fireWaiters(op);
	});

	return {
		addRealm(endpoint, label) {
			const realm: IRealm = { endpoint, label, ops: new Set(), inflight: new Map(), unsubscribe: () => {} };
			realm.unsubscribe = endpoint.subscribe((message) => {
				const m = asBusMessage(message);
				if (!m) return;
				switch (m[ENVELOPE]) {
					case 'register':
						for (const op of m.ops) {
							const current = opOwners.get(op);
							if (current && current !== realm) {
								console.error(`[BusRouter] op '${op}' registered by '${label}' but already owned by '${current.label}' — keeping the first owner`);
								continue;
							}
							realm.ops.add(op);
							opOwners.set(op, realm);
							fireWaiters(op);
						}
						break;
					case 'unregister':
						for (const op of m.ops) {
							if (opOwners.get(op) === realm) opOwners.delete(op);
							realm.ops.delete(op);
						}
						break;
					case 'request':
						// A realm's outbound request — answer back over ITS endpoint
						// with ITS correlation id.
						routeRequest(m.op, m.params, m.timeoutMs, (resp) => endpoint.post({ ...resp, id: m.id } satisfies IBusResponseMessage), () => `h${++hopSeq}`);
						break;
					case 'emitOp':
						routeEmitOp(m.op, m.params);
						break;
					case 'response': {
						// A realm answering a request the router forwarded to it.
						const entry = realm.inflight.get(m.id);
						if (!entry) return;
						realm.inflight.delete(m.id);
						clearTimeout(entry.timer);
						entry.respond(m);
						break;
					}
				}
			});
			realms.add(realm);

			return () => {
				realms.delete(realm);
				realm.unsubscribe();
				for (const op of realm.ops) {
					if (opOwners.get(op) === realm) opOwners.delete(op);
				}
				// A dead realm answers nothing: reject everything in flight to it.
				for (const [, entry] of realm.inflight) {
					clearTimeout(entry.timer);
					entry.respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Realm '${realm.label}' detached` });
				}
				realm.inflight.clear();
			};
		},

		broadcastEmitOp(op, params) {
			for (const realm of realms) {
				realm.endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
			}
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			for (const realm of [...realms]) {
				realm.unsubscribe();
				for (const [, entry] of realm.inflight) {
					clearTimeout(entry.timer);
					entry.respond({ [ENVELOPE]: 'response', id: '', ok: false, error: 'Bus router disposed' });
				}
			}
			realms.clear();
			opOwners.clear();
			rootBus.setForwarder(null);
		},
	};
}

/**
 * An in-process endpoint pair — the transport for two "realms" sharing one
 * JS realm (cloud root↔local attachments, tests). Delivery is a microtask,
 * matching postMessage semantics closely enough that code written against
 * one transport behaves on the other.
 *
 * @returns Two connected endpoints.
 */
export function createLocalEndpointPair(): [IBusEndpoint, IBusEndpoint] {
	const make = (): { subs: Set<(m: unknown) => void>; endpoint: IBusEndpoint & { deliver(m: unknown): void } } => {
		const subs = new Set<(m: unknown) => void>();
		return {
			subs,
			endpoint: {
				post: () => { /* wired below */ },
				subscribe: (cb) => {
					subs.add(cb);
					return () => subs.delete(cb);
				},
				deliver: (m) => {
					Promise.resolve().then(() => {
						for (const cb of subs) cb(m);
					});
				},
			},
		};
	};
	const a = make();
	const b = make();
	a.endpoint.post = (m) => b.endpoint.deliver(m);
	b.endpoint.post = (m) => a.endpoint.deliver(m);
	return [a.endpoint, b.endpoint];
}
