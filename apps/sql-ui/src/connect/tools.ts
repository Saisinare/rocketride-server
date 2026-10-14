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
// CONNECT — TOOLS (how SQL Explorer calls each node tool)
// =============================================================================
//
// The per-tool table the shared session is built from: which tools may be
// repeated, how long the client waits, and how a result is judged.
//
// `execute` has NO client timeout: SQL nodes set no statement deadline (the
// engine reads a result of any length), so a long analytical query is
// legitimate and the app offers "Stop waiting" instead. Reflection is bounded
// — generously, because a large database really does take minutes to reflect.
// =============================================================================

import { checkObject } from 'shared/explorer/checks';
import type { IToolSessionOptions } from 'shared/explorer/connect/session';

/** The reflection budget: reading a very large catalogue can take minutes. */
const REFLECTION_TIMEOUT_MS = 5 * 60 * 1000;

/** Per-tool specs for the SQL node tools. */
export const SQL_TOOLS: IToolSessionOptions['tools'] = {
	// A statement may write: never repeated unless the caller marks it a read.
	execute: { idempotent: false, timeoutMs: null, check: checkObject },
	get_schema: { idempotent: true, timeoutMs: REFLECTION_TIMEOUT_MS, check: checkObject },
	refresh_schema: { idempotent: true, timeoutMs: REFLECTION_TIMEOUT_MS, check: checkObject },
	dialect: { idempotent: true, timeoutMs: 15_000, check: checkObject },
};
