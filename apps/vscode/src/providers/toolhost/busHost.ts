// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BUS HOST — the extension host as the framework root of the shell bus
// =============================================================================
//
// The VS Code side of the hub-and-spoke bus (shell busBridge.ts): this
// process owns the real engine connection(s), so the ROUTER and the CLIENT
// BROKER live here. Webview realms attach as spokes over their postMessage
// channels and reach the engine ONLY through `request()` — no realm socket,
// no authToken in any webview.
//
//   - `attachWebview` adapts one webview to an IBusEndpoint (its own
//     onDidReceiveMessage listener — bus traffic rides the `__rrbus`
//     envelope and never touches the owning provider's message switch).
//   - `registerMonitorBroker` registers the broker-owned monitor pair
//     (cross-realm refcounts; the engine sees ONE subscription set). Every
//     OTHER op this host serves registers via apps/vscode/src/ops
//     (registerVscodeOps) — NAMED ops only; registration is the allowlist.
//   - MIRRORS: connection/account/services state is broadcast to every
//     realm as fire-and-forget `mirror.*` ops; realms re-emit locally so
//     synchronous reads (isConnected, getAccountInfo, getCachedServices)
//     answer from mirrored state.
// =============================================================================

import * as vscode from 'vscode';
// Deep imports on purpose — the barrel drags .tsx into the extension
// host's no-DOM compile; busOps/busBridge are the sanctioned ext-host-safe
// .ts leaves (same rule as toolRelay).
import { createOpBus, registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus } from 'shell/src/ops/busOps';
import { createBusRouter } from 'shell/src/ops/busBridge';
import { createRetainedRegistry } from 'shell/src/ops/retained';
import type { IRetainedRegistry } from 'shell/src/ops/retained';
import type { ClientOpMap } from 'shell/src/ops/clientOps';
import type { IBusEndpoint, IBusRouter, SummonLookup } from 'shell/src/ops/busBridge';
import type { ConnectionManager } from '../../connection/connection';
import { getLogger } from '../../shared/util/output';

/** The bus envelope key (must match shell busBridge.ts). */
const BUS_ENVELOPE = '__rrbus';

/** A monitor key as the SDK takes it (token- or project-scoped). */
type MonitorKey = { token: string } | { projectId: string; source: string; teamId?: string; pipeId?: number; runKind?: 'dev' | 'deploy' };

export class BusHost {
	/** The root's op bus — broker ops register here. */
	public readonly rootBus: IOpBus = createOpBus();

	private router: IBusRouter;
	private logger = getLogger();
	private disposables: vscode.Disposable[] = [];

	/** Cross-realm monitor refcounts: keyString -> type -> count. The engine
	 *  sees the MERGED registration; realms never clobber each other. */
	private monitorCounts = new Map<string, Map<string, number>>();
	/** The parsed key behind each keyString (for SDK calls + resubscribe). */
	private monitorKeys = new Map<string, MonitorKey>();

	/** Wire-trace gate (rocketride.debug.busTrace) — read once, refreshed on
	 *  config change so it can be toggled without a reload. */
	private traceEnabled = vscode.workspace.getConfiguration('rocketride').get<boolean>('debug.busTrace', false);

	/** The root's retained-topic registry — THE authority every realm's
	 *  publish/subscribe/read resolves against. */
	public readonly retained: IRetainedRegistry = createRetainedRegistry();

	constructor(public readonly connectionManager: ConnectionManager, summon?: SummonLookup) {
		this.router = createBusRouter(this.rootBus, { retained: this.retained, ...(summon ? { summon } : {}) });
		this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride.debug.busTrace')) {
				this.traceEnabled = vscode.workspace.getConfiguration('rocketride').get<boolean>('debug.busTrace', false);
			}
		}));
	}

	// =========================================================================
	// WEBVIEW ATTACHMENT
	// =========================================================================

	/**
	 * Attaches one webview realm to the bus. Bus traffic is filtered off the
	 * webview's message stream by envelope — the owning provider's own
	 * switch never sees it.
	 *
	 * @param webview - The realm's webview.
	 * @param label - Diagnostics label ('sidebar', 'page:account', ...).
	 * @returns Detach function — call on dispose AND before re-resolve (a
	 *   rebooted webview is a fresh realm).
	 */
	public attachWebview(webview: vscode.Webview, label: string): () => void {
		// Wire-level trace of EVERY bus message crossing this webview's
		// bridge, both directions — the one place that sees it all. Gated
		// behind rocketride.debug.busTrace (off by default; very chatty).
		const describe = (m: unknown): string => {
			const b = m as Record<string, unknown>;
			const kind = String(b[BUS_ENVELOPE]);
			const bits = [kind, b.op ?? '', b.id ?? '', b.ops ? (b.ops as string[]).join(',') : '', b.ok === undefined ? '' : (b.ok ? 'ok' : `ERR:${String(b.error)}`)];
			return bits.filter(Boolean).join(' ');
		};
		const subs = new Set<(m: unknown) => void>();
		const listener = webview.onDidReceiveMessage((message) => {
			if (!message || typeof message !== 'object' || typeof (message as Record<string, unknown>)[BUS_ENVELOPE] !== 'string') return;
			if (this.traceEnabled) this.logger.output(`[bus <- ${label}] ${describe(message)}`);
			for (const cb of subs) cb(message);
		});
		const endpoint: IBusEndpoint = {
			post: (m) => {
				if (this.traceEnabled) this.logger.output(`[bus -> ${label}] ${describe(m)}`);
				void webview.postMessage(m);
			},
			subscribe: (cb) => {
				subs.add(cb);
				return () => subs.delete(cb);
			},
		};
		const detachRealm = this.router.addRealm(endpoint, label);
		return () => {
			detachRealm();
			listener.dispose();
			subs.clear();
		};
	}

	// =========================================================================
	// MIRRORS — root state pushed into every realm
	// =========================================================================

	/**
	 * Starts the mirror feed: connection status, account info, and the
	 * services cache PUBLISHED as retained topics — the registry replays the
	 * current snapshot to every late subscriber (a fresh realm needs no pull),
	 * and each realm's ConnectionManager folds the deliveries into its
	 * synchronous readers (installMirrorSubscriptions).
	 *
	 * PER-TOPIC: each state family publishes from its own trigger events —
	 * the services blob (the heaviest payload) never rides a status tick,
	 * and account only crosses when it actually changed.
	 */
	public startMirrors(): void {
		const pushStatus = (): void => this.retained.publish('shell:status', this.statusTopic());
		for (const event of ['shell:statusChange', 'shell:connected', 'shell:disconnected'] as const) {
			this.connectionManager.on(event, pushStatus);
			this.disposables.push({ dispose: () => this.connectionManager.off(event, pushStatus) });
		}
		const pushAccount = (): void => this.retained.publish('shell:account', this.connectionManager.getClient()?.getAccountInfo() ?? null);
		this.connectionManager.on('shell:accountUpdate', pushAccount);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:accountUpdate', pushAccount) });
		const pushServices = (): void => this.retained.publish('shell:services', this.connectionManager.getCachedServices() ?? null);
		this.connectionManager.on('shell:servicesUpdated', pushServices);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:servicesUpdated', pushServices) });
		// Seed the topics so realms attaching before the first trigger event
		// still replay a current snapshot.
		pushStatus();
		pushAccount();
		pushServices();
		// Engine events are a STREAM, not state — they stay on the broadcast
		// lane; realms fold task/status events off their local bus exactly as
		// they did off their own socket.
		const onEvent = (event: unknown): void => {
			this.router.broadcastEmitOp('mirror.event', { event });
		};
		this.connectionManager.on('shell:event', onEvent);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:event', onEvent) });
	}

	/** The 'shell:status' snapshot (consumed by CM installMirrorSubscriptions). */
	private statusTopic(): Record<string, unknown> {
		return {
			connected: this.connectionManager.isConnected(),
			status: this.connectionManager.getConnectionStatus(),
			engineHttpUrl: (this.connectionManager.getHttpUrl() || '').replace(/\/$/, ''),
		};
	}

	// =========================================================================
	// CLIENT BROKER — first slice (named ops only)
	// =========================================================================

	/**
	 * Registers the brokered `client.*` surface: the SHARED named-op table
	 * (shell clientOps.ts — one allowlist for every framework root), with
	 * THIS host's monitor pair registered first so the shared table skips
	 * it — multi-realm hosts need the broker-owned cross-realm refcounts.
	 */
	public registerMonitorBroker(): void {
		// Monitors — the BROKER is the single authority (see file header).
		// This is the one client.* override that lives in BusHost itself:
		// cross-realm refcounts are broker STATE, not host policy. Every
		// other op registration is apps/vscode/src/ops (registerVscodeOps).
		registerOpHandlers<ClientOpMap>(this.rootBus, {
			'client.addMonitor': async (p) => this.addMonitor(p),
			'client.removeMonitor': async (p) => this.removeMonitor(p),
		});

		// Re-register the merged monitor set after every reconnect — ONE
		// resubscribe, regardless of how many realms hold subscriptions.
		const resubscribe = (): void => {
			void this.resubscribeMonitors();
		};
		this.connectionManager.on('shell:connected', resubscribe);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:connected', resubscribe) });
	}

	/** Fire-and-forget op to EVERY attached realm (host pushes like the
	 *  Environment page's prefill ride this). */
	public broadcastEmitOp(op: string, params: unknown): void {
		this.router.broadcastEmitOp(op, params);
	}

	private keyString(key: MonitorKey): string {
		return 'token' in key ? `t:${key.token}` : `p:${key.teamId ?? ''}:${key.projectId}:${key.source}:${key.pipeId ?? ''}:${key.runKind ?? ''}`;
	}

	private async addMonitor({ key, types }: { key: MonitorKey; types: string[] }): Promise<void> {
		const ks = this.keyString(key);
		const counts = this.monitorCounts.get(ks) ?? new Map<string, number>();
		const fresh: string[] = [];
		for (const t of types) {
			const n = counts.get(t) ?? 0;
			counts.set(t, n + 1);
			if (n === 0) fresh.push(t);
		}
		this.monitorCounts.set(ks, counts);
		this.monitorKeys.set(ks, key);
		// Only a type's FIRST subscriber reaches the engine.
		if (fresh.length > 0) {
			try {
				await this.connectionManager.getClient()?.addMonitor(key as never, fresh as never);
			} catch (err) {
				// Roll the fresh types back so a retry re-reaches the engine.
				for (const t of fresh) {
					const n = counts.get(t) ?? 1;
					if (n <= 1) counts.delete(t);
					else counts.set(t, n - 1);
				}
				throw err;
			}
		}
	}

	private async removeMonitor({ key, types }: { key: MonitorKey; types: string[] }): Promise<void> {
		const ks = this.keyString(key);
		const counts = this.monitorCounts.get(ks);
		if (!counts) return;
		const dead: string[] = [];
		for (const t of types) {
			const n = counts.get(t) ?? 0;
			if (n <= 1) {
				counts.delete(t);
				if (n === 1) dead.push(t);
			} else {
				counts.set(t, n - 1);
			}
		}
		if (counts.size === 0) {
			this.monitorCounts.delete(ks);
			this.monitorKeys.delete(ks);
		}
		// Only the LAST unsubscriber reaches the engine.
		if (dead.length > 0) {
			await this.connectionManager.getClient()?.removeMonitor(key as never, dead as never).catch(() => { /* connection may be gone — server-side state died with it */ });
		}
	}

	/** One merged resubscribe after reconnect (monitor state is per-connection
	 *  server-side; the broker replays the union, exactly once). */
	private async resubscribeMonitors(): Promise<void> {
		for (const [ks, counts] of this.monitorCounts) {
			const key = this.monitorKeys.get(ks);
			if (!key || counts.size === 0) continue;
			try {
				await this.connectionManager.getClient()?.addMonitor(key as never, [...counts.keys()] as never);
			} catch (err) {
				this.logger.error(`[BusHost] monitor resubscribe failed for ${ks}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.router.dispose();
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
		this.monitorCounts.clear();
		this.monitorKeys.clear();
	}
}
