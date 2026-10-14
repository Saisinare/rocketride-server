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
// EXPLORER CONNECT — DISCOVERY (find tool nodes in running pipelines)
// =============================================================================
//
// Discovery reads `client.getTasks()`: the RUNNING tasks the caller may see,
// each with its OWN token, team, run kind and owner, in one call. That fixes
// four limits of the page-and-lookup approach it replaces:
//
//   - the old listing stopped at one page of 100, oldest first; getTasks is
//     not paged, so the newest running pipelines are not missing;
//   - the old token lookup sent no team and resolved only the caller's own dev
//     run, so a team deployment failed to open (or, worse, the caller's own run
//     of the same project opened in its place); getTasks hands over each run's
//     own token, so no lookup happens at all;
//   - a developer's run and the team's deployment of one pipeline collided on
//     one key; the key now carries run kind, owner and team (see keys.ts);
//   - a task row already carries `pipeline.components`, so no per-task
//     pipeline fetch is needed (getTaskPipeline is only a fallback, bounded).
//
// A connection is a ROLE MAP, not a provider set: SQL and Graph pass one
// `tools` role filled by any source; Vector passes `ingest_1` / `chat_1` /
// `tools_1`, grouped into ONE connection per project, owner and run context.
// Runs of different owners, teams or run kinds never merge, and a missing role
// is reported as missing — never borrowed from another run.
//
// TOKENS: a task token is read here and returned beside the endpoint, never
// inside it. The caller (the store) puts it in a transient vault; nothing else
// in the library ever sees it.
//
// ANOTHER ORGANIZATION'S RUNS: getTasks also returns the caller's own runs
// started in an organization they have since switched away from (the server
// scopes a user-owned run by its owner, not by the current organization).
// Such a row is dropped here, before grouping, when the identity lists its
// organization's teams and the row's team is not one of them, so neither its
// card nor its token reaches the store (see identity.ts).
// =============================================================================

import { isPlainObject } from '../checks';
import { buildEndpointKey, legacyKeyFromKey, roleKeySource } from '../keys';
import type { IExplorerClient, IExplorerComponent, IExplorerEndpoint, IExplorerIdentity, IExplorerPipeline, IExplorerTaskRow, IRoleBinding, IRoleSpec } from '../types';
import { identityCanCallTools, runInIdentityOrganization } from './identity';

// =============================================================================
// TYPES
// =============================================================================

/** What discovery needs to know. */
export interface IDiscoveryOptions {
	/** Component provider ids that are tool nodes for this app. */
	providers: ReadonlySet<string>;
	/** The role map a connection is made of. */
	roles: IRoleSpec;
	/** Who is signed in (used only to hint `inaccessible`); optional. */
	identity?: IExplorerIdentity | null;
	/** Concurrency of the getTaskPipeline fallback (default 4). */
	concurrency?: number;
}

/** One discovered endpoint, with the secret that belongs in the vault. */
export interface IDiscoveredEndpoint {
	/** The token-free endpoint. */
	endpoint: IExplorerEndpoint;
	/** The tools role's task token — for the store's transient vault ONLY. */
	token: string | null;
	/** Whether the identity can tell the caller may invoke tools (hint; undefined = unknown). */
	callHint: boolean | undefined;
}

// =============================================================================
// ROW READING
// =============================================================================

/**
 * Narrow one raw `getTasks` element. The data arrives from the network and may
 * come from a newer or older server, so nothing is trusted: a row without a
 * token or a source is not usable and is dropped.
 *
 * @param raw - One element of the getTasks array.
 * @returns The row, or null when it cannot be used.
 */
export function readTaskRow(raw: unknown): IExplorerTaskRow | null {
	if (!isPlainObject(raw)) return null;
	const source = typeof raw.source === 'string' ? raw.source : '';
	const token = typeof raw.token === 'string' ? raw.token : '';
	if (source === '' || token === '') return null;
	const pipeline = isPlainObject(raw.pipeline) ? (raw.pipeline as IExplorerPipeline) : null;
	return {
		name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : source,
		description: typeof raw.description === 'string' ? raw.description : '',
		source,
		token,
		status: typeof raw.status === 'string' ? raw.status : '',
		teamId: typeof raw.teamId === 'string' ? raw.teamId : '',
		runKind: typeof raw.runKind === 'string' && raw.runKind !== '' ? raw.runKind : 'dev',
		ownerKind: typeof raw.ownerKind === 'string' ? raw.ownerKind : '',
		ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
		pipeline,
	};
}

/**
 * The project id a row carries, or '' when the pipeline has none.
 *
 * @param row - The task row.
 * @returns `pipeline.project_id`, or ''.
 */
function projectIdOf(row: IExplorerTaskRow): string {
	const id = row.pipeline?.project_id;
	return typeof id === 'string' ? id : '';
}

/**
 * The owner kind of a row, normalised. The server stamps `ownerKind`; an
 * older server that does not is read the way its own default reads: a deploy
 * is team-owned, anything else user-owned.
 *
 * @param row - The task row.
 * @returns 'user' or 'team'.
 */
function ownerKindOf(row: IExplorerTaskRow): 'user' | 'team' {
	if (row.ownerKind === 'team' || row.ownerKind === 'user') return row.ownerKind;
	return row.runKind === 'deploy' ? 'team' : 'user';
}

// =============================================================================
// GROUPING
// =============================================================================

/** The rows of one connection, by role. */
interface IGroup {
	/** Role name -> the row filling it (null = not running). */
	byRole: Map<string, IExplorerTaskRow | null>;
	/** The row that supplies the pipeline components and identity fields. */
	anchor: IExplorerTaskRow;
}

/**
 * Whether the spec is the single-role shape (one role, any source): each
 * running task is then its own connection.
 *
 * @param spec - The role spec.
 * @returns True for the SQL/Graph shape.
 */
function isSingleRole(spec: IRoleSpec): boolean {
	const names = Object.keys(spec.roles);
	return names.length === 1 && spec.roles[names[0] as string]?.sources === null;
}

/**
 * Group running task rows into connections.
 *
 * Single-role: one group per row. Multi-role: rows are grouped by run kind,
 * owner kind, owner id, team and project, then each role takes the row whose
 * source it names (lowest source id first when several qualify). A row whose
 * pipeline carries no project id cannot be proven to belong to any other row's
 * project, so it is never grouped with another row.
 *
 * @param rows - The usable task rows.
 * @param spec - The role spec.
 * @returns The groups, each keeping the rows' original order.
 */
function groupRows(rows: IExplorerTaskRow[], spec: IRoleSpec): IGroup[] {
	const roleNames = Object.keys(spec.roles);
	if (isSingleRole(spec)) {
		return rows.map((row) => ({ byRole: new Map([[spec.toolsRole, row]]), anchor: row }));
	}

	const buckets = new Map<string, IExplorerTaskRow[]>();
	rows.forEach((row, index) => {
		const project = projectIdOf(row);
		// No project id: unique bucket, so it never merges with another row.
		const bucketKey = project === ''
			? `~${index}`
			: [row.runKind, ownerKindOf(row), row.ownerId, row.teamId, project].map(encodeURIComponent).join('|');
		const bucket = buckets.get(bucketKey);
		if (bucket) bucket.push(row);
		else buckets.set(bucketKey, [row]);
	});

	const groups: IGroup[] = [];
	for (const bucket of buckets.values()) {
		const byRole = new Map<string, IExplorerTaskRow | null>();
		let matched = 0;
		for (const role of roleNames) {
			const def = spec.roles[role]!;
			const sources = def.sources ?? [];
			const candidates = bucket.filter((row) => sources.includes(row.source)).sort((a, b) => a.source.localeCompare(b.source));
			byRole.set(role, candidates[0] ?? null);
			if (candidates[0]) matched += 1;
		}
		// A project none of whose running sources fills a role is not this app's.
		if (matched === 0) continue;
		const anchor = byRole.get(spec.toolsRole) ?? [...byRole.values()].find((row): row is IExplorerTaskRow => row !== null)!;
		groups.push({ byRole, anchor });
	}
	return groups;
}

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Run `work` over `items` with at most `limit` in flight, preserving order.
 *
 * @param items - The inputs.
 * @param limit - Maximum concurrent calls (at least 1).
 * @param work - The async mapper; must not throw (callers catch inside).
 * @returns The results in input order.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await work(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Read the components of a group's pipeline: from the task row when it carries
 * them, otherwise through `getTaskPipeline` (a bounded fallback).
 *
 * @param client - The client.
 * @param group - The group.
 * @returns The components, or null when they cannot be read.
 */
async function componentsOf(client: IExplorerClient, group: IGroup): Promise<IExplorerComponent[] | null> {
	const embedded = group.anchor.pipeline?.components;
	if (Array.isArray(embedded)) return embedded;
	try {
		const pipeline = await client.getTaskPipeline(group.anchor.token);
		const components = isPlainObject(pipeline) ? pipeline.components : undefined;
		return Array.isArray(components) ? (components as IExplorerComponent[]) : null;
	} catch {
		// One unreadable task must not break discovery of the rest.
		return null;
	}
}

/**
 * Discover every tool node reachable through the caller's running tasks.
 *
 * Throws only when the initial `getTasks` fails; everything after it is
 * per-task and per-group and never aborts discovery of the rest.
 *
 * @param client - The shell's RocketRide client.
 * @param options - Providers, role map and identity.
 * @returns Endpoints (state `probing`, or `stopped` when a required role is not running), sorted by pipeline name, node id, key.
 */
export async function discoverToolEndpoints(client: IExplorerClient, options: IDiscoveryOptions): Promise<IDiscoveredEndpoint[]> {
	const raw = await client.getTasks();
	const identity = options.identity ?? null;
	const rows = (Array.isArray(raw) ? raw : [])
		.map(readTaskRow)
		.filter((row): row is IExplorerTaskRow => row !== null && runInIdentityOrganization(identity, row.teamId));
	const groups = groupRows(rows, options.roles);
	const componentLists = await mapWithConcurrency(groups, options.concurrency ?? 4, (group) => componentsOf(client, group));

	const seen = new Map<string, number>();
	const found: IDiscoveredEndpoint[] = [];
	groups.forEach((group, groupIndex) => {
		const components = componentLists[groupIndex];
		if (!components) return;
		const toolsRow = group.byRole.get(options.roles.toolsRole) ?? null;
		const { anchor } = group;
		const ownerKind = ownerKindOf(anchor);
		const projectId = projectIdOf(anchor);

		const roles: Record<string, IRoleBinding | null> = {};
		const keyRoles: Record<string, string> = {};
		const missingRoles: string[] = [];
		for (const role of Object.keys(options.roles.roles)) {
			const row = group.byRole.get(role) ?? null;
			roles[role] = row ? { source: row.source } : null;
			keyRoles[role] = roleKeySource(options.roles.roles[role]!, row ? row.source : null);
			if (!row) missingRoles.push(role);
		}
		const requiredMissing = missingRoles.filter((role) => options.roles.roles[role]?.required);

		for (const component of components) {
			if (!component || typeof component.id !== 'string' || typeof component.provider !== 'string' || component.id === '') continue;
			if (!options.providers.has(component.provider)) continue;
			const key = buildEndpointKey({
				runKind: anchor.runKind,
				ownerKind,
				ownerId: anchor.ownerId,
				teamId: anchor.teamId,
				projectId,
				roles: keyRoles,
				nodeId: component.id,
			});
			const stopped = requiredMissing.length > 0;
			// Two groups can only share a key when their rows carry no project id
			// (see IExplorerEndpoint.projectId): that is not provable to be one
			// project, so the groups stay unmerged and the CALLABLE one wins the
			// key — a stopped duplicate must never hide a live connection.
			const earlier = seen.get(key);
			if (earlier !== undefined) {
				if (found[earlier]!.endpoint.state !== 'stopped' || stopped) continue;
				found.splice(earlier, 1);
				seen.clear();
				found.forEach((entry, index) => seen.set(entry.endpoint.key, index));
			}
			seen.set(key, found.length);
			const endpoint: IExplorerEndpoint = {
				key,
				legacyKey: legacyKeyFromKey(key),
				projectId,
				pipelineName: anchor.name,
				runKind: anchor.runKind,
				ownerKind,
				ownerId: anchor.ownerId,
				teamId: anchor.teamId,
				roles,
				missingRoles,
				source: toolsRow ? toolsRow.source : '',
				nodeId: component.id,
				nodeName: typeof component.name === 'string' && component.name !== '' ? component.name : component.id,
				provider: component.provider,
				state: stopped ? 'stopped' : 'probing',
				running: !stopped,
			};
			if (stopped) endpoint.stateDetail = `Not running: ${requiredMissing.join(', ')} ${requiredMissing.length === 1 ? 'source is' : 'sources are'} not running for this pipeline.`;
			found.push({
				endpoint,
				token: toolsRow ? toolsRow.token : null,
				callHint: identityCanCallTools(options.identity ?? null, ownerKind, anchor.ownerId),
			});
		}
	});

	found.sort((a, b) => a.endpoint.pipelineName.localeCompare(b.endpoint.pipelineName)
		|| a.endpoint.nodeId.localeCompare(b.endpoint.nodeId)
		|| a.endpoint.key.localeCompare(b.endpoint.key));
	return found;
}
