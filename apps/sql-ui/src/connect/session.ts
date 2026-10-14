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
// CONNECT — SESSION (tool invocation bound to one endpoint)
// =============================================================================
//
// A thin SQL face over the shared tool session
// (shared/explorer/connect/session): it drives the node's shared SQL tools
// (execute / get_schema / refresh_schema / dialect) through the endpoint
// store, which owns the task token. The ISqlSession contract is unchanged.
//
// Retry is no longer "a fresh token lookup returned a different token" (task
// tokens are deterministic, so that never fired after a restart). It is the
// shared rule: one retry, idempotent tools only, only on the server's
// TASK_STOPPED code, and only after re-discovery finds the SAME endpoint
// running again. `execute` is repeated only when the caller marks the
// statement a read.
// =============================================================================

import type { RocketRideClient } from 'shell';
import { isStaleError } from 'shared/explorer/errors';
import type { IToolSession } from 'shared/explorer/connect/session';
import type { IGenerationTicket } from 'shared/explorer/generation';
import { sqlEndpoints } from './endpointStore';
import type {
	ISqlEndpoint,
	ISqlExecuteResult,
	ISqlProbeResult,
	ISqlSchemaResponse,
	ISqlSession,
	SqlDialect,
} from './types';

// =============================================================================
// DIALECT MAPPING
// =============================================================================

/** Dialect strings this app recognises from the node's `dialect` tool. */
const KNOWN_DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'clickhouse', 'neo4j']);

/**
 * Map a node-reported dialect string onto the app's SqlDialect union.
 *
 * @param value - The raw dialect string from the node.
 * @returns The matching SqlDialect, or 'unknown'.
 */
function toDialect(value: unknown): SqlDialect {
	return typeof value === 'string' && KNOWN_DIALECTS.has(value) ? (value as SqlDialect) : 'unknown';
}

// =============================================================================
// SESSION IMPLEMENTATION
// =============================================================================

/** ISqlSession over the shared tool session. */
class SqlToolSession implements ISqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: ISqlEndpoint;

	/** The shared session (it reads the task token from the store's vault at call time). */
	private readonly session: IToolSession;

	/**
	 * @param session - The shared session for the endpoint.
	 * @param endpoint - The endpoint to bind to.
	 */
	constructor(session: IToolSession, endpoint: ISqlEndpoint) {
		this.session = session;
		this.endpoint = endpoint;
	}

	/** @inheritdoc */
	async execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<ISqlExecuteResult> {
		// Omit `params` entirely when there is nothing to bind: the node's
		// placeholder rewriting is skipped for an empty list, so an unbound
		// statement keeps travelling exactly as it did before.
		const params = opts?.params;
		const input = params && params.length > 0 ? { sql, params } : { sql };
		// Default NO retry: an unmarked statement may well be a write. The
		// caller's ticket goes down with the call, so a request it abandoned is
		// never sent again by the session's retry.
		const generation = opts?.generation;
		return this.session.invoke<ISqlExecuteResult>('execute', input, { idempotent: opts?.idempotent === true, ...(generation === undefined ? {} : { generation }) });
	}

	/** @inheritdoc */
	async getSchema(table?: string): Promise<ISqlSchemaResponse> {
		return this.session.invoke<ISqlSchemaResponse>('get_schema', table ? { table } : {});
	}

	/** @inheritdoc */
	async refreshSchema(): Promise<ISqlSchemaResponse> {
		try {
			return await this.session.invoke<ISqlSchemaResponse>('refresh_schema', {});
		} catch (error) {
			// A dropped (superseded) result is not a failure of the tool.
			if (isStaleError(error)) throw error;
			// ANY other failure falls back. A node without the tool and a node
			// that simply could not answer are indistinguishable at this layer,
			// and matching the engine's error wording would rot the first time it
			// changed. Serve the task-start snapshot and flag it, rather than
			// present it as freshly reflected; when the fallback ALSO fails, its
			// error is the one the caller sees.
			const schema = await this.getSchema();
			return { ...schema, stale: true };
		}
	}

	/** @inheritdoc */
	async dialect(): Promise<SqlDialect> {
		const result = await this.session.invoke<{ dialect?: string }>('dialect', {});
		return toDialect(result?.dialect);
	}
}

// =============================================================================
// FACTORY + PROBE
// =============================================================================

/**
 * Create a live session bound to one database endpoint.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The endpoint to bind to.
 * @returns The bound session.
 */
export function createSqlSession(client: RocketRideClient, endpoint: ISqlEndpoint): ISqlSession {
	return new SqlToolSession(sqlEndpoints.session(client, endpoint), endpoint);
}

/**
 * Probe an endpoint before binding to it: report dialect and a shallow
 * schema summary. Never throws — failures come back as `ok: false`.
 *
 * @param client - The shell's RocketRide client.
 * @param endpoint - The endpoint to probe.
 * @returns The probe result.
 */
export async function probeSqlEndpoint(client: RocketRideClient, endpoint: ISqlEndpoint): Promise<ISqlProbeResult> {
	const session = createSqlSession(client, endpoint);
	try {
		// Dialect first (cheapest), then a full reflection for the summary.
		const dialect = await session.dialect();
		const schema = await session.getSchema();
		if (schema.error) {
			return { ok: false, dialect, error: schema.error };
		}
		return {
			ok: true,
			dialect,
			database: schema.database,
			tableCount: schema.tables ? Object.keys(schema.tables).length : 0,
		};
	} catch (err) {
		return { ok: false, dialect: 'unknown', error: err instanceof Error ? err.message : String(err) };
	}
}
