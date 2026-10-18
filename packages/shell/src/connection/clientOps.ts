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
// CLIENT OPS — the brokered SDK surface, one NAMED op per client call
// =============================================================================
//
// The framework root's `client.*` registrations. Every op is a deliberate
// allowlist entry against one SDK method — NEVER a generic {command,args}
// passthrough (that would re-expose the whole client to every realm; the
// registry IS the mediation point for third-party tools on the bus).
//
// Registered at EVERY framework root: the cloud shell realm (Shell
// bootstrap) and the VS Code extension host (BusHost — which SKIPS the
// monitor pair and registers its own broker-owned, cross-realm-refcounted
// versions; in cloud the single realm's client is its own refcount
// authority, so the thin passthroughs suffice).
//
// Binary rule: payload fields crossing the bus are JSON-safe — file WRITE
// bytes ride base64 (`dataB64`), file READS stay out of the client entirely
// (presigned URL + plain HTTP; only fsGetUrl/fsStat metadata remotes).
// =============================================================================

import type { IOpBus } from './busOps';
import type { ShellOpMap, ShellOpSpec } from './busOps';

/** A monitor key as the SDK takes it. */
export type ClientMonitorKey = { token: string } | { projectId: string; source: string; teamId?: string; pipeId?: number; runKind?: 'dev' | 'deploy' };

/**
 * The brokered client vocabulary. Results are typed loosely where the SDK
 * shape is pass-through — tightening is incremental and local.
 */
export interface ClientOpMap extends ShellOpMap {
	// ── Dashboard / tasks ────────────────────────────────────────────────────
	'client.getDashboard': ShellOpSpec<Record<string, never>, unknown>;
	'client.listTasks': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.listConnections': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.getTasks': ShellOpSpec<Record<string, never>, unknown>;
	'client.getTaskToken': ShellOpSpec<{ projectId: string; source: string; teamId?: string }, unknown>;
	'client.getTaskPipeline': ShellOpSpec<{ token: string }, unknown>;
	'client.getTaskStatus': ShellOpSpec<{ token: string; timeout?: number }, unknown>;
	'client.terminate': ShellOpSpec<{ token: string }, unknown>;
	'client.use': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.restart': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.validate': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.tool': ShellOpSpec<{ token: string; tool: string; nodeId?: string; input?: unknown; timeout?: number }, unknown>;

	// ── Monitors (broker-owned in multi-realm hosts) ─────────────────────────
	'client.addMonitor': ShellOpSpec<{ key: ClientMonitorKey; types: string[] }, void>;
	'client.removeMonitor': ShellOpSpec<{ key: ClientMonitorKey; types: string[] }, void>;

	// ── File store (JSON-safe payloads; see header's binary rule) ────────────
	'client.fsListDir': ShellOpSpec<{ path: string }, unknown>;
	'client.fsStat': ShellOpSpec<{ path: string }, unknown>;
	'client.fsGetUrl': ShellOpSpec<{ path: string; expiresIn?: number; downloadName?: string }, string>;
	'client.fsReadString': ShellOpSpec<{ path: string }, string>;
	'client.fsWriteString': ShellOpSpec<{ path: string; text: string }, unknown>;
	'client.fsReadJson': ShellOpSpec<{ path: string }, unknown>;
	'client.fsWriteJson': ShellOpSpec<{ path: string; value: unknown }, unknown>;
	'client.fsRename': ShellOpSpec<{ from: string; to: string }, unknown>;
	'client.fsDelete': ShellOpSpec<{ path: string }, unknown>;
	'client.fsMkdir': ShellOpSpec<{ path: string }, unknown>;
	'client.fsRmdir': ShellOpSpec<{ path: string; recursive?: boolean }, unknown>;
	'client.fsOpen': ShellOpSpec<{ path: string; mode: string }, unknown>;
	'client.fsWrite': ShellOpSpec<{ handle: unknown; dataB64: string }, unknown>;
	'client.fsClose': ShellOpSpec<{ handle: unknown; mode?: string }, unknown>;

	// ── Profiler ─────────────────────────────────────────────────────────────
	'client.cprofileStart': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.cprofileStop': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.cprofileStatus': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.cprofileReport': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.cprofileReportTree': ShellOpSpec<Record<string, unknown>, unknown>;
	'client.cprofileThreads': ShellOpSpec<Record<string, unknown>, unknown>;

	'client.getService': ShellOpSpec<{ service: string }, unknown>;

	// ── Account (env autocomplete) ───────────────────────────────────────────
	'client.getEnvironmentKeys': ShellOpSpec<Record<string, never>, unknown>;
}

/** What the registration needs from its host — the SDK client and liveness.
 *  Typed structurally so BOTH ConnectionManager classes (shell and the VS
 *  Code extension host's) satisfy it without a shared base. */
export interface IClientOpsSource {
	getClient(): unknown;
	isConnected(): boolean;
}

/** Registration options. */
export interface IClientOpsOptions {
	/** Ops to leave UNREGISTERED (the VS Code root pre-registers its
	 *  broker-owned monitor pair; cloud registers everything). */
	skip?: ReadonlySet<string>;
}

/** Decodes a base64 payload into the Uint8Array the SDK wants. */
function b64ToBytes(b64: string): Uint8Array {
	if (typeof atob === 'function') {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	// Node (extension host) — looked up dynamically so the browser compile
	// (no node types) never sees the Buffer name.
	const nodeBuffer = (globalThis as Record<string, unknown>).Buffer as { from(s: string, enc: string): Uint8Array } | undefined;
	if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, 'base64'));
	throw new Error('No base64 decoder available in this realm');
}

/**
 * Registers the brokered `client.*` surface on a framework root's bus.
 *
 * @param bus - The root's op bus.
 * @param source - The root's client accessor + liveness.
 * @param options - Ops to skip (host-specific overrides).
 * @returns Unregister-all function.
 */
export function registerClientOps(bus: IOpBus, source: IClientOpsSource, options?: IClientOpsOptions): () => void {
	/** The connected client, or throws the standard not-connected error. */
	// The SDK client's structural surface, loosely typed — every call below
	// is still a NAMED allowlist entry; the looseness is only local plumbing.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const client = (): any => {
		const c = source.getClient();
		if (!c || !source.isConnected()) throw new Error('Not connected to server');
		return c;
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const entries: Array<[string, (p: any) => unknown]> = [
		['client.getDashboard', () => client().getDashboard()],
		['client.listTasks', (p) => client().listTasks(p)],
		['client.listConnections', (p) => client().listConnections(p)],
		['client.getTasks', () => client().getTasks()],
		['client.getTaskToken', (p) => client().getTaskToken(p)],
		['client.getTaskPipeline', (p) => client().getTaskPipeline(p.token)],
		['client.getTaskStatus', (p) => client().getTaskStatus(p.token, p.timeout !== undefined ? { timeout: p.timeout } : undefined)],
		['client.terminate', (p) => client().terminate(p.token)],
		['client.use', (p) => client().use(p)],
		['client.restart', (p) => client().restart(p)],
		['client.validate', (p) => client().validate(p)],
		['client.tool', (p) => client().tool(p)],
		['client.addMonitor', (p) => client().addMonitor(p.key, p.types)],
		['client.removeMonitor', (p) => client().removeMonitor(p.key, p.types)],
		['client.fsListDir', (p) => client().fsListDir(p.path)],
		['client.fsStat', (p) => client().fsStat(p.path)],
		['client.fsGetUrl', (p) => client().fsGetUrl(p.path, p.expiresIn, p.downloadName)],
		['client.fsReadString', (p) => client().fsReadString(p.path)],
		['client.fsWriteString', (p) => client().fsWriteString(p.path, p.text)],
		['client.fsReadJson', (p) => client().fsReadJson(p.path)],
		['client.fsWriteJson', (p) => client().fsWriteJson(p.path, p.value)],
		['client.fsRename', (p) => client().fsRename(p.from, p.to)],
		['client.fsDelete', (p) => client().fsDelete(p.path)],
		['client.fsMkdir', (p) => client().fsMkdir(p.path)],
		['client.fsRmdir', (p) => client().fsRmdir(p.path, p.recursive === true)],
		['client.fsOpen', (p) => client().fsOpen(p.path, p.mode)],
		['client.fsWrite', (p) => client().fsWrite(p.handle, b64ToBytes(p.dataB64))],
		['client.fsClose', (p) => client().fsClose(p.handle, p.mode)],
		['client.cprofileStart', (p) => client().cprofileStart(p)],
		['client.cprofileStop', (p) => client().cprofileStop(p)],
		['client.cprofileStatus', (p) => client().cprofileStatus(p)],
		['client.cprofileReport', (p) => client().cprofileReport(p)],
		['client.cprofileReportTree', (p) => client().cprofileReportTree(p)],
		['client.cprofileThreads', (p) => client().cprofileThreads(p)],
		['client.getService', (p) => client().getService(p.service)],
		['client.getEnvironmentKeys', () => client().account.getEnvironmentKeys()],
	];

	const offs: Array<() => void> = [];
	for (const [op, fn] of entries) {
		if (options?.skip?.has(op)) continue;
		if (bus.hasHandler(op)) continue; // host override already in place
		offs.push(bus.handle(op, fn));
	}
	return () => {
		for (const off of offs) off();
	};
}
