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

import { registerOpHandlers } from './busOps';
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

	// ── Profiler (params use the wire's snake_case keys; the SDK methods
	//    take POSITIONAL args, so the impls destructure — never pass `p`
	//    wholesale or the dict nests under `target`) ──────────────────────────
	'client.cprofileStart': ShellOpSpec<{ target?: string | null; session?: Record<string, unknown> }, unknown>;
	'client.cprofileStop': ShellOpSpec<{ target?: string | null }, unknown>;
	'client.cprofileStatus': ShellOpSpec<{ target?: string | null }, unknown>;
	'client.cprofileReport': ShellOpSpec<{ target?: string | null }, unknown>;
	'client.cprofileReportTree': ShellOpSpec<{ target?: string | null; max_depth?: number; min_pct?: number; include_system?: boolean; thread?: number | null }, unknown>;
	'client.cprofileThreads': ShellOpSpec<{ target?: string | null }, unknown>;

	'client.getService': ShellOpSpec<{ service: string }, unknown>;

	// ── Account (env autocomplete) ───────────────────────────────────────────
	'client.getEnvironmentKeys': ShellOpSpec<Record<string, never>, unknown>;

	// ── Account (profile / org / members / teams / keys / env) ──────────────
	'client.account.getProfile': ShellOpSpec<Record<string, never>, unknown>;
	'client.account.updateProfile': ShellOpSpec<{ fields: Record<string, unknown> }, unknown>;
	'client.account.setDevTeam': ShellOpSpec<{ teamId: string }, unknown>;
	'client.account.setDefaultOrg': ShellOpSpec<{ orgId: string }, unknown>;
	'client.account.deleteAccount': ShellOpSpec<Record<string, never>, unknown>;
	'client.account.getOrg': ShellOpSpec<{ orgId?: string }, unknown>;
	'client.account.updateOrgName': ShellOpSpec<{ orgId: string; name: string }, unknown>;
	'client.account.listKeys': ShellOpSpec<Record<string, never>, unknown>;
	'client.account.createKey': ShellOpSpec<{ params: Record<string, unknown> }, unknown>;
	'client.account.revokeKey': ShellOpSpec<{ keyId: string }, unknown>;
	'client.account.listMembers': ShellOpSpec<{ orgId: string }, unknown>;
	'client.account.inviteMember': ShellOpSpec<{ orgId: string; params: Record<string, unknown> }, unknown>;
	'client.account.updateMemberRole': ShellOpSpec<{ orgId: string; userId: string; role: string }, unknown>;
	'client.account.removeMember': ShellOpSpec<{ orgId: string; userId: string }, unknown>;
	'client.account.resendInvite': ShellOpSpec<{ orgId: string; userId: string }, unknown>;
	'client.account.listTeams': ShellOpSpec<{ orgId: string }, unknown>;
	'client.account.getTeamDetail': ShellOpSpec<{ orgId: string; teamId: string }, unknown>;
	'client.account.createTeam': ShellOpSpec<{ orgId: string; name: string }, unknown>;
	'client.account.deleteTeam': ShellOpSpec<{ orgId: string; teamId: string }, unknown>;
	'client.account.addTeamMember': ShellOpSpec<{ orgId: string; params: Record<string, unknown> }, unknown>;
	'client.account.updateTeamMemberPerms': ShellOpSpec<{ orgId: string; params: Record<string, unknown> }, unknown>;
	'client.account.removeTeamMember': ShellOpSpec<{ orgId: string; params: Record<string, unknown> }, unknown>;
	// Env ops carry an optional CONNECTION dimension: a multi-connection host
	// (VS Code dev/deploy) pre-registers its own slot-resolving handlers; the
	// shared entries below serve single-connection roots and ignore it.
	'client.account.getEnv': ShellOpSpec<{ scope: 'org' | 'team' | 'user'; scopeId?: string; connection?: 'dev' | 'deploy' }, unknown>;
	'client.account.setEnv': ShellOpSpec<{ scope: 'org' | 'team' | 'user'; env: Record<string, string>; scopeId?: string; connection?: 'dev' | 'deploy' }, unknown>;

	// ── Billing / checkout ───────────────────────────────────────────────────
	'client.billing.getDetails': ShellOpSpec<{ orgId: string }, unknown>;
	'client.billing.getProductPrices': ShellOpSpec<{ appId: string }, unknown>;
	'client.billing.createCheckoutSession': ShellOpSpec<{ orgId: string; appId: string; priceId: string; promotionCode?: string }, unknown>;
	'client.billing.validatePromoCode': ShellOpSpec<{ orgId: string; code: string; priceId?: string }, unknown>;
	'client.billing.redeemPromoCode': ShellOpSpec<{ orgId: string; code: string }, unknown>;
	// returnUrl is HOST POLICY: the framework root decides where Stripe sends
	// the browser back (cloud: its own origin; VS Code: the public site) — a
	// socketless webview's origin is never a valid return target.
	'client.billing.createPortalSession': ShellOpSpec<{ orgId: string }, unknown>;
	'client.billing.cancelSubscription': ShellOpSpec<{ orgId: string; appId: string }, unknown>;
	'client.billing.upgradeSubscription': ShellOpSpec<{ orgId: string; appId: string; newPriceId: string }, unknown>;
	'client.billing.purchaseTopup': ShellOpSpec<{ orgId: string; priceId: string }, unknown>;
	'client.billing.getCreditBalance': ShellOpSpec<{ orgId: string }, unknown>;
	'client.billing.listCreditPacks': ShellOpSpec<Record<string, never>, unknown>;
	'client.billing.getTransactions': ShellOpSpec<{ orgId: string; options?: Record<string, unknown> }, unknown>;
	'client.billing.getTransactionDistinct': ShellOpSpec<{ orgId: string; field: string }, unknown>;
	'client.billing.getUsageByUser': ShellOpSpec<{ orgId: string }, unknown>;
	'client.billing.getUsageByTeam': ShellOpSpec<{ orgId: string }, unknown>;
	'client.billing.createCreditCheckout': ShellOpSpec<{ orgId: string; packId: string }, unknown>;
	// No SDK method exists for confirm_pending (the old call sites used a
	// phantom `dapRequest` cast that threw at runtime); the op wraps the
	// public client.call() exactly as BillingApi wraps its other verbs.
	'client.billing.confirmPending': ShellOpSpec<{ appId: string; subscriptionId: string; priceId: string }, unknown>;
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
	/** Where Stripe sends the browser back from the customer portal — HOST
	 *  POLICY (cloud: its own origin; VS Code: the public site). Required
	 *  for `client.billing.createPortalSession` to be served. */
	portalReturnUrl?: () => string;
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

	// One implementation per op, keyed by the op name itself and typed
	// against ClientOpMap: a duplicate name, an unknown name, or a declared
	// op with no implementation are all COMPILE errors.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const impls: { [K in keyof ClientOpMap]: (p: any) => unknown } = {
		'client.getDashboard': () => client().getDashboard(),
		'client.listTasks': (p) => client().listTasks(p),
		'client.listConnections': (p) => client().listConnections(p),
		'client.getTasks': () => client().getTasks(),
		'client.getTaskToken': (p) => client().getTaskToken(p),
		'client.getTaskPipeline': (p) => client().getTaskPipeline(p.token),
		'client.getTaskStatus': (p) => client().getTaskStatus(p.token, p.timeout !== undefined ? { timeout: p.timeout } : undefined),
		'client.terminate': (p) => client().terminate(p.token),
		'client.use': (p) => client().use(p),
		'client.restart': (p) => client().restart(p),
		'client.validate': (p) => client().validate(p),
		'client.tool': (p) => client().tool(p),
		'client.addMonitor': (p) => client().addMonitor(p.key, p.types),
		'client.removeMonitor': (p) => client().removeMonitor(p.key, p.types),
		'client.fsListDir': (p) => client().fsListDir(p.path),
		'client.fsStat': (p) => client().fsStat(p.path),
		'client.fsGetUrl': (p) => client().fsGetUrl(p.path, p.expiresIn, p.downloadName),
		'client.fsReadString': (p) => client().fsReadString(p.path),
		'client.fsWriteString': (p) => client().fsWriteString(p.path, p.text),
		'client.fsReadJson': (p) => client().fsReadJson(p.path),
		'client.fsWriteJson': (p) => client().fsWriteJson(p.path, p.value),
		'client.fsRename': (p) => client().fsRename(p.from, p.to),
		'client.fsDelete': (p) => client().fsDelete(p.path),
		'client.fsMkdir': (p) => client().fsMkdir(p.path),
		'client.fsRmdir': (p) => client().fsRmdir(p.path, p.recursive === true),
		'client.fsOpen': (p) => client().fsOpen(p.path, p.mode),
		'client.fsWrite': (p) => client().fsWrite(p.handle, b64ToBytes(p.dataB64)),
		'client.fsClose': (p) => client().fsClose(p.handle, p.mode),
		'client.cprofileStart': (p) => client().cprofileStart(p.target ?? null, p.session),
		'client.cprofileStop': (p) => client().cprofileStop(p.target ?? null),
		'client.cprofileStatus': (p) => client().cprofileStatus(p.target ?? null),
		'client.cprofileReport': (p) => client().cprofileReport(p.target ?? null),
		'client.cprofileReportTree': (p) => client().cprofileReportTree(p.target ?? null, p.max_depth, p.min_pct, p.include_system, p.thread ?? null),
		'client.cprofileThreads': (p) => client().cprofileThreads(p.target ?? null),
		'client.getService': (p) => client().getService(p.service),
		'client.getEnvironmentKeys': () => client().account.getEnvironmentKeys(),
		'client.account.getProfile': () => client().account.getProfile(),
		'client.account.updateProfile': (p) => client().account.updateProfile(p.fields),
		'client.account.setDevTeam': (p) => client().account.setDevTeam(p.teamId),
		'client.account.setDefaultOrg': (p) => client().account.setDefaultOrg(p.orgId),
		'client.account.deleteAccount': () => client().account.deleteAccount(),
		'client.account.getOrg': (p) => client().account.getOrg(p.orgId),
		'client.account.updateOrgName': (p) => client().account.updateOrgName(p.orgId, p.name),
		'client.account.listKeys': () => client().account.listKeys(),
		'client.account.createKey': (p) => client().account.createKey(p.params),
		'client.account.revokeKey': (p) => client().account.revokeKey(p.keyId),
		'client.account.listMembers': (p) => client().account.listMembers(p.orgId),
		'client.account.inviteMember': (p) => client().account.inviteMember(p.orgId, p.params),
		'client.account.updateMemberRole': (p) => client().account.updateMemberRole(p.orgId, p.userId, p.role),
		'client.account.removeMember': (p) => client().account.removeMember(p.orgId, p.userId),
		'client.account.resendInvite': (p) => client().account.resendInvite(p.orgId, p.userId),
		'client.account.listTeams': (p) => client().account.listTeams(p.orgId),
		'client.account.getTeamDetail': (p) => client().account.getTeamDetail(p.orgId, p.teamId),
		'client.account.createTeam': (p) => client().account.createTeam(p.orgId, p.name),
		'client.account.deleteTeam': (p) => client().account.deleteTeam(p.orgId, p.teamId),
		'client.account.addTeamMember': (p) => client().account.addTeamMember(p.orgId, p.params),
		'client.account.updateTeamMemberPerms': (p) => client().account.updateTeamMemberPerms(p.orgId, p.params),
		'client.account.removeTeamMember': (p) => client().account.removeTeamMember(p.orgId, p.params),
		// Single-connection roots ignore the connection dimension (multi-
		// connection hosts pre-register their own slot-resolving handlers).
		'client.account.getEnv': (p) => client().account.getEnv(p.scope, p.scopeId),
		'client.account.setEnv': (p) => client().account.setEnv(p.scope, p.env, p.scopeId),
		'client.billing.getDetails': (p) => client().billing.getDetails(p.orgId),
		'client.billing.getProductPrices': (p) => client().billing.getProductPrices(p.appId),
		'client.billing.createCheckoutSession': (p) => client().billing.createCheckoutSession(p.orgId, p.appId, p.priceId, p.promotionCode),
		'client.billing.validatePromoCode': (p) => client().billing.validatePromoCode(p.orgId, p.code, p.priceId),
		'client.billing.redeemPromoCode': (p) => client().billing.redeemPromoCode(p.orgId, p.code),
		'client.billing.createPortalSession': (p) => client().billing.createPortalSession(p.orgId, portalReturnUrl()),
		'client.billing.cancelSubscription': (p) => client().billing.cancelSubscription(p.orgId, p.appId),
		'client.billing.upgradeSubscription': (p) => client().billing.upgradeSubscription(p.orgId, p.appId, p.newPriceId),
		'client.billing.purchaseTopup': (p) => client().billing.purchaseTopup(p.orgId, p.priceId),
		'client.billing.getCreditBalance': (p) => client().billing.getCreditBalance(p.orgId),
		'client.billing.listCreditPacks': () => client().billing.listCreditPacks(),
		'client.billing.getTransactions': (p) => client().billing.getTransactions(p.orgId, p.options),
		'client.billing.getTransactionDistinct': (p) => client().billing.getTransactionDistinct(p.orgId, p.field),
		'client.billing.getUsageByUser': (p) => client().billing.getUsageByUser(p.orgId),
		'client.billing.getUsageByTeam': (p) => client().billing.getUsageByTeam(p.orgId),
		'client.billing.createCreditCheckout': (p) => client().billing.createCreditCheckout(p.orgId, p.packId, portalReturnUrl()),
		'client.billing.confirmPending': (p) => client().call('rrext_account_billing', { subcommand: 'confirm_pending', appId: p.appId, subscriptionId: p.subscriptionId, priceId: p.priceId }),
	};

	/** The host's Stripe return target, or throws (portal ops need one). */
	function portalReturnUrl(): string {
		const url = options?.portalReturnUrl?.();
		if (!url) throw new Error('No portal return URL configured at this framework root');
		return url;
	}

	return registerOpHandlers<ClientOpMap>(bus, impls, options);
}
