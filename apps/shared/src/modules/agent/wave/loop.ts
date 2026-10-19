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
// WAVE LOOP — plan, act, check, until the model is done
// =============================================================================

/**
 * One run of the agent. Each wave asks the model for a plan, runs the plan's
 * tool calls, and feeds their summaries into the next wave's question. The
 * run ends when the model's answer is accepted, on a reply that stays unusable,
 * or when the model cannot be reached; there is no wave limit.
 *
 * An answer is accepted only when a check has passed in a wave after the last
 * change, so the model cannot skip checking. A reply that cannot be used is
 * sent back once, saying why. When the run ends without an accepted answer,
 * the loop asks for a best-effort answer from what was gathered, and failing
 * that writes one itself.
 *
 * This is a port of Wave's driver (`nodes/src/nodes/agent_rocketride/
 * rocketride_agent.py`) and the result bookkeeping of its executor
 * (`executor.py`). The texts the model reads match Wave's word for word, as
 * Wave's prompt teaches the model to read them. One change: the note that
 * sends a bad reply back goes in the question's context, not its
 * instructions, so the cached start stays identical on every call.
 */

import type { CheckLedger } from '../checks/check';
import type { AgentTool } from '../tools';
import { MEMORY_PEEK_TOOL, peek, resolveAnswerRefs, resolveArgRefs, resultKey, RunMemory } from './memory';
import { buildWaveQuestion, parseReply, type PromptPrefix } from './plan';
import type { HistoryTurn, ModelCall, PlanReply, QuestionSpec, ResultEntry, StopReason, ToolCall } from './plan';
import { previewArgs, summarize, withCommas } from './summary';

// =============================================================================
// OPTIONS AND RESULT
// =============================================================================

/** What a run needs. */
export interface LoopOptions {
	/** What the user asked for. */
	request: string;
	/** Earlier conversation turns, oldest first. */
	history: HistoryTurn[];
	/** The fixed start of every wave question (see buildPrefix). */
	prefix: PromptPrefix;
	/** The tools the model may call; the check tool among them is named `check`. */
	tools: AgentTool[];
	/** Asks the model one question. */
	model: ModelCall;
	/** Where the check tool records its reports; the loop reads it after each wave. */
	ledger: CheckLedger;
	/** Whether a call to this tool changes the work, so a check must follow it. */
	isChange: (tool: string) => boolean;
	/** Sends one chunk of progress text to the user; `detail` is the raw model reply the chunk carries, sent only when recording. */
	emit: (type: 'thinking', text: string, detail?: string) => void;
	/** Whether each thinking chunk carries the raw reply of the model call behind it (default false). */
	recordReplies?: boolean;
	/** The time limit for a tool's calls, in milliseconds; anything but a positive number means TOOL_TIMEOUT_MS. */
	timeoutMs?: (tool: string) => number;
}

/** How a run ended. */
export interface LoopResult {
	/** The answer for the user, with its memory references filled in. */
	answer: string;
	/** Why the run stopped. */
	stopReason: StopReason;
	/** How many waves ran, counting the one the run stopped in. */
	waves: number;
	/** Whether any call changed the work (even one that failed). */
	changed: boolean;
	/** How long each model call took, in milliseconds, in call order. */
	modelMs: number[];
}

/** The time limit for a tool call when the options set none: 5 minutes, Wave's default. */
export const TOOL_TIMEOUT_MS = 300_000;

// =============================================================================
// TEXTS — Wave's words, which its prompt teaches the model to read
// =============================================================================

/** The tool whose passing result lets the run finish. */
const CHECK_TOOL = 'check';

/** The tool the loop runs itself. */
const PEEK_TOOL = MEMORY_PEEK_TOOL.name;

/** Why a done with a check in the same reply is sent back: the model has not read the check's result yet. */
const READ_THE_CHECK = `Not finished: read the result of ${CHECK_TOOL} before done=true.`;

/** The role of the best-effort question: a plain answer, not a plan. */
const FALLBACK_ROLE = 'You are a helpful assistant.';

/** The best-effort question. */
const FALLBACK_QUESTION = 'Based on the above, provide a complete and accurate final answer. The work stopped before it was finished: if something the goal needs is still unknown, say what is missing rather than guessing.';

/** Most characters of a peek's data the best-effort question shows. */
const FALLBACK_PREVIEW_CHARS = 2000;

/** The text of the extra row that carries the accepted answer's raw reply. */
const FINAL_REPLY_ROW = 'Final answer reply';

/** The text of the extra row that carries the best-effort answer's raw reply. */
const BEST_EFFORT_ROW = 'Best-effort answer reply';

/** The text of a wave's row when the wave has nothing else to say but its raw reply is recorded. */
const BARE_REPLY_ROW = 'Model reply';

/** Most characters of a call's error a thinking line shows. */
const THINKING_ERROR_CHARS = 200;

/** The arguments that name what a call works on, in the order a thinking line looks for them. */
const PRIMARY_ARGS = ['path', 'oldPath', 'target', 'app', 'name', 'task_token', 'project_id'];

/** The note that sends an unusable reply back, for that one call. */
function retryNote(problems: string[]): string {
	return `Your previous reply was not usable: ${problems.join('; ')}. Reply with exactly one of the two shapes in Response Format.`;
}

/** The entry telling the model why its done=true was not accepted. */
function refusal(wave: number, message: string): ResultEntry {
	return { tool: 'reply-check', key: `wave-${wave}.done`, error: message };
}

/** The entries for what a usable reply got wrong: a bad remove only tidies memory, so it is a note; anything else was dropped, so it is an error. */
function problemEntries(wave: number, problems: string[]): ResultEntry[] {
	return problems.map((problem, i) => {
		const key = `wave-${wave}.check${i}`;
		return problem.startsWith('remove') ? { tool: 'reply-check', key, note: `Ignored: ${problem}` } : { tool: 'reply-check', key, error: `Skipped: ${problem}` };
	});
}

/** The error for a call left out of required arguments: it names them and shows where arguments go. */
function skipMessage(tool: string, missing: string[]): string {
	return `Skipped: ${tool} is missing required argument(s) ${missing.map((name) => `'${name}'`).join(', ')}. Put arguments under "args": {"tool": "${tool}", "args": {...}}`;
}

/** An error's message, for whatever was thrown. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// ENTRIES — what a call leaves in the next prompt
// =============================================================================

/** A result entry; a memory.peek entry also carries Wave's peek fields beside the call's. */
interface Entry extends ResultEntry {
	/** The path the peek read. */
	path?: string;
	/** What the peek read. */
	preview?: string;
	/** Whether a path peek's array was capped. */
	truncated?: boolean;
	/** How many array items a capped peek returned. */
	returned_items?: number;
	/** How many items the capped array has. */
	total_items?: number;
	/** Where a chunk peek started. */
	offset?: number;
	/** How many characters a chunk peek returned. */
	length?: number;
	/** How long the stored text is. */
	total_chars?: number;
}

/** A call made ready to run: its arguments resolved, or why it cannot run, or its peek already read. `skipped` marks a call left out for missing required arguments. */
type Prepared = { call: ToolCall; args: Record<string, unknown> } | { call: ToolCall; entry: Entry; skipped?: true };

/** What a wave's calls left behind, in call order. */
interface Acted {
	/** One entry per call. */
	entries: Entry[];
	/** Per call, whether it was left out for missing required arguments, so it neither changed the work nor checked it. */
	skipped: boolean[];
}

/** A canonical text of a value, keys sorted, so two equal calls give the same text. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
		return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	});
}

/** The value stored under a key, storing `value` first when nothing is (Python's setdefault). */
function setDefault(map: Map<string, string>, key: string, value: string): string {
	const prior = map.get(key);
	if (prior !== undefined) return prior;
	map.set(key, value);
	return value;
}

/** The first non-empty string among the arguments that name what a call works on, or ''. */
function primaryArg(args: Record<string, unknown>): string {
	for (const name of PRIMARY_ARGS) {
		const value = args[name];
		if (typeof value === 'string' && value) return value;
	}
	return '';
}

/** One thinking line for a call: what it worked on, and whether it worked. */
function thinkingLine(call: ToolCall, entry: Entry): string {
	const target = primaryArg(call.args);
	const outcome = entry.error === undefined ? 'ok' : `error: ${entry.error.slice(0, THINKING_ERROR_CHARS)}`;
	return `- ${call.tool}${target ? ` ${target}` : ''} — ${outcome}`;
}

// =============================================================================
// BEST EFFORT — the answer when the run ends unfinished
// =============================================================================

/** A memory.peek entry as one line: what was read, the data, and whether it is all of it (Wave's `_peek_line`). */
function peekLine(entry: Entry): string {
	let text = entry.preview ?? '';
	if (text.length > FALLBACK_PREVIEW_CHARS) {
		text = `${text.slice(0, FALLBACK_PREVIEW_CHARS)} ... (cut at ${withCommas(FALLBACK_PREVIEW_CHARS)} of ${withCommas(text.length)} characters)`;
	}
	const notes: string[] = [];
	if (entry.truncated) notes.push(`showing ${entry.returned_items} of ${entry.total_items} items`);
	if (typeof entry.total_chars === 'number') {
		const start = entry.offset ?? 0;
		notes.push(`characters ${withCommas(start)} to ${withCommas(start + (entry.length ?? 0))} of ${withCommas(entry.total_chars)}`);
	}
	const where = entry.path ? `${entry.path} = ` : '';
	return where + text + (notes.length ? ` (${notes.join('; ')})` : '');
}

/** An entry as one line of what was gathered; errors are named, so the answer does not read them as success. */
function gatheredLine(entry: Entry): string {
	if (entry.error !== undefined) return `- ${entry.tool}: ERROR — ${entry.error}`;
	if ('preview' in entry) return `- ${entry.tool}: ${peekLine(entry)}`;
	return `- ${entry.tool}: ${entry.summary ?? ''}`;
}

/** The answer when even the best-effort call fails: the cause, then the notes and facts as they stand (Wave's `_partial_report`). */
function partialReport(cause: string, lines: string[], scratch: string): string {
	const parts = [`I could not finish: ${cause}.`];
	if (scratch) parts.push('', 'My working notes:', scratch);
	if (lines.length) parts.push('', 'What I gathered:', ...lines);
	return parts.join('\n');
}

// =============================================================================
// WAVE SCHEDULING — which calls run together, which wait, and how long each may take
// =============================================================================

/**
 * Wave's Python loop starts every call in a wave at once. That is wrong for
 * calls that change the same file: two edits of one file, or an edit under a
 * folder that an earlier call renames, must run in the order the model planned
 * them. This section keeps the parallelism and adds that order. A call starts as
 * soon as every EARLIER call in the wave whose write paths overlap its own has
 * finished or timed out. A call with no write paths (a read, a check, a deploy
 * query) never waits and never holds anything back.
 *
 * Each call also has a time limit, set per tool. A call over its limit is
 * reported as timed out and the wave moves on; the tool itself cannot be
 * cancelled, so its promise goes into `late` until it settles. The loop checks
 * `late.size` to know whether a timed-out call may still be changing things.
 */

// =============================================================================
// OUTCOMES — what a call left behind
// =============================================================================

/** How one call ended: its result, or the error that stopped it (with whether the time limit did). */
export type CallOutcome = { ok: true; result: string; ms: number } | { ok: false; error: string; ms: number; timedOut: boolean };

// =============================================================================
// WRITE PATHS — what a call changes
// =============================================================================

/**
 * Spells a path argument the way the file tools do, so two spellings of one file compare equal.
 * This mirrors the first steps of `normalizePath` in `../filesystem.ts`: the argument becomes text
 * (`path: 7` is the file `7`), `\` becomes `/`, and empty segments go (`apps//x/` is `apps/x`).
 * It does not refuse `.` or `..`; the tool does that when it runs. A path that is empty after
 * this gives no path.
 */
function cleanPath(value: unknown): string[] {
	const path = String(value ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.join('/');
	return path ? [path] : [];
}

/**
 * The workspace paths a call changes, spelled as the file tools spell them (see `cleanPath`).
 * Reads and every tool that does not touch workspace files return `[]`, as does
 * a call whose path argument is missing or empty (the tool itself reports that).
 */
function writePaths(call: ToolCall): string[] {
	const { args } = call;
	switch (call.tool) {
		case 'write_file':
		case 'edit_file':
		case 'create_directory':
		case 'delete_file':
			return cleanPath(args.path);
		case 'rename':
			return [...cleanPath(args.oldPath), ...cleanPath(args.newPath)];
		case 'create_app':
			return typeof args.appName === 'string' ? cleanPath(`apps/${args.appName}-ui`) : [];
		default:
			return [];
	}
}

/** True when one path equals the other or is a folder holding it (`apps/x` holds `apps/x/a.ts`, not `apps/xy`). */
function pathsTouch(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when any path in `a` equals, holds or sits under any path in `b`. Empty lists never overlap. */
function overlaps(a: string[], b: string[]): boolean {
	return a.some((x) => b.some((y) => pathsTouch(x, y)));
}

// =============================================================================
// ONE CALL — run it against its time limit
// =============================================================================

/**
 * Runs one call and settles with its outcome; never rejects. A limit that is
 * not a positive finite number means no limit.
 */
function runOne(call: ToolCall, exec: (call: ToolCall) => Promise<string>, limitMs: number, late: Set<Promise<unknown>>): Promise<CallOutcome> {
	const began = performance.now();
	const elapsed = (): number => Math.round(performance.now() - began);

	return new Promise<CallOutcome>((resolve) => {
		let over = false;
		const running = new Promise<string>((done) => done(exec(call)));

		// Tracks the call after the wave stops waiting for it. It never rejects, so a
		// late failure is not an unhandled rejection, and it leaves `late` once settled.
		const tracked: Promise<void> = running
			.catch(() => undefined)
			.then(() => {
				late.delete(tracked);
			});

		const timer =
			Number.isFinite(limitMs) && limitMs > 0
				? setTimeout(() => {
						over = true;
						late.add(tracked);
						resolve({ ok: false, error: `TimeoutError: no result after ${limitMs / 1000} s`, ms: elapsed(), timedOut: true });
					}, limitMs)
				: undefined;

		running.then(
			(result) => {
				if (over) return;
				clearTimeout(timer);
				resolve({ ok: true, result, ms: elapsed() });
			},
			(error: unknown) => {
				if (over) return;
				clearTimeout(timer);
				resolve({ ok: false, error: error instanceof Error ? error.message : String(error), ms: elapsed(), timedOut: false });
			}
		);
	});
}

// =============================================================================
// WAVE — all the calls, in planned order where they touch the same files
// =============================================================================

/**
 * Runs a wave's calls and returns their outcomes in call order.
 *
 * A call starts once every earlier call in the wave with overlapping write
 * paths has settled or timed out, so calls on different files run together and
 * calls on the same file run as planned. The call's clock starts when it
 * starts, not while it waits. A call that outlives its limit is reported as
 * `timedOut` and its promise sits in `opts.late` until it settles.
 *
 * @param calls - The wave's tool calls, in the order the model planned them.
 * @param exec - Runs one call and resolves with its result text; a throw becomes an `ok: false` outcome.
 * @param opts.timeoutMs - The time limit in milliseconds for a tool; zero or infinity means none.
 * @param opts.late - Collects the promises of timed-out calls that are still running.
 */
async function runWave(calls: ToolCall[], exec: (call: ToolCall) => Promise<string>, opts: { timeoutMs: (tool: string) => number; late: Set<Promise<unknown>> }): Promise<CallOutcome[]> {
	const held = calls.map(writePaths);
	const outcomes: Promise<CallOutcome>[] = [];

	calls.forEach((call, i) => {
		const earlier = outcomes.filter((_, j) => overlaps(held[i], held[j]));
		const start = (): Promise<CallOutcome> => runOne(call, exec, opts.timeoutMs(call.tool), opts.late);
		// With nothing to wait for, the call starts now, in this turn, so unrelated calls overlap fully.
		outcomes.push(earlier.length === 0 ? start() : Promise.all(earlier).then(start));
	});

	return Promise.all(outcomes);
}

// =============================================================================
// RAW REPLIES — a model reply as the Thinking group shows it
// =============================================================================

/**
 * When a run records its model calls, each thinking row carries the raw text
 * the model replied with, so a reader can see what the model actually wrote
 * and not only what the loop made of it. The text is never parsed or
 * re-formatted here; it is only capped, so one runaway reply cannot bloat the
 * chat or the saved session.
 */

/** Most characters of one raw reply a row carries. */
const REPLY_CAP = 50_000;

/**
 * Cuts a raw reply at the cap.
 *
 * @param raw - A reply as the model returned it.
 * @returns The reply itself, or its first REPLY_CAP characters followed by a line saying how many more there were.
 */
function capReply(raw: string): string {
	if (raw.length <= REPLY_CAP) return raw;
	return `${raw.slice(0, REPLY_CAP)}\n[truncated ${raw.length - REPLY_CAP} more characters]`;
}

/**
 * The detail of a wave whose first reply was unusable and whose retry never
 * answered (the call threw): the first reply, labelled, with nothing after it.
 *
 * @param first - The wave's first raw reply.
 * @returns The capped reply under a `first reply:` label.
 */
function firstReplyOnly(first: string): string {
	return `first reply:\n${capReply(first)}`;
}

/**
 * The detail of one wave's thinking row: its raw reply, or both replies when
 * the first was unusable and was sent back once. Each reply is capped on its own.
 *
 * @param first - The wave's first raw reply.
 * @param retry - The raw reply to the retry, when there was one.
 * @returns The first reply alone, or both labelled `first reply` and `retry`.
 */
function joinReplies(first: string, retry?: string): string {
	if (retry === undefined) return capReply(first);
	return `${firstReplyOnly(first)}\n\nretry:\n${capReply(retry)}`;
}

// =============================================================================
// RUN — the state of one run, and its steps
// =============================================================================

/** One run's memory, results and check state. */
class WaveRun {
	/** Every stored tool result. */
	readonly memory = new RunMemory();
	/** How long each model call took. */
	readonly modelMs: number[] = [];
	/** The model's working notes, carried from wave to wave. */
	scratch = '';
	/** The last wave with a change (even a failed one), or -1. */
	lastChange = -1;
	/** The last wave whose checks all passed, or -1. */
	lastCheck = -1;
	/** What every earlier call left behind, oldest first; what the next question shows. */
	private results: Entry[] = [];
	/** The raw replies of the wave being planned, first reply first: one, or two when the first was sent back. Kept only when recording. */
	private waveReplies: string[] = [];
	/** The calls that timed out and are still running. */
	private readonly late = new Set<Promise<unknown>>();
	/** The timed-out calls seen running at the last look, so a return is noticed. */
	private readonly watched = new Set<Promise<unknown>>();
	/** Each call (tool and arguments as written) by the key of its first result. */
	private readonly seenCalls = new Map<string, string>();
	/** Each stored result's text by the key that first held it. */
	private readonly seenResults = new Map<string, string>();
	/** The keys the model removed. */
	private readonly removed = new Set<string>();
	/** The tools by name. */
	private readonly tools: Map<string, AgentTool>;

	/** Starts a run. */
	constructor(private readonly o: LoopOptions) {
		this.tools = new Map(o.tools.map((tool) => [tool.name, tool]));
	}

	/** Whether the run has anything to answer from: a result, or notes. */
	get gathered(): boolean {
		return this.results.length > 0 || this.scratch.length > 0;
	}

	/** Asks the model, timing the call. */
	private async ask(q: QuestionSpec): Promise<string> {
		const began = performance.now();
		try {
			return await this.o.model(q);
		} finally {
			this.modelMs.push(Math.round(performance.now() - began));
		}
	}

	/**
	 * Asks for this wave's plan. A reply with nothing to run and no answer is
	 * sent back once, its problems in a note at the end of the context. The
	 * retry was asked only to fix its shape, so the first reply's notes stand
	 * unless the retry writes new ones. When recording and the retry call
	 * throws, the first reply still gets its row before the error goes on.
	 */
	async plan(): Promise<PlanReply> {
		const state = { request: this.o.request, scratch: this.scratch, results: this.results, notes: [] };
		this.waveReplies = [];
		const firstText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, state));
		if (this.o.recordReplies) this.waveReplies.push(firstText);
		let reply = parseReply(firstText);
		if (!reply.toolCalls.length && !reply.done) {
			const first = reply.scratch;
			try {
				const retryText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, { ...state, notes: [retryNote(reply.problems)] }));
				if (this.o.recordReplies) this.waveReplies.push(retryText);
				reply = parseReply(retryText);
			} catch (error) {
				// The first reply's notes are all this wave produced; keep them for the best-effort answer.
				if (first.trim()) this.scratch = first;
				// Recording: the first reply is the wave's only reply, and an unusable one is the one most worth reading.
				if (this.o.recordReplies) this.o.emit('thinking', reply.thought.trim() ? reply.thought : BARE_REPLY_ROW, firstReplyOnly(firstText));
				throw error;
			}
			if (first && !reply.scratch.trim()) reply = { ...reply, scratch: first };
		}
		// An empty scratch never wipes the notes so far.
		this.scratch = reply.scratch || this.scratch;
		return reply;
	}

	/**
	 * Runs a wave's calls and returns their entries, in call order. A call
	 * missing a required argument is skipped, with an error telling the model
	 * where arguments go. Arguments are resolved next, and a call whose
	 * reference names nothing does not run. memory.peek reads memory here,
	 * before this wave's results are stored; every other call goes through the
	 * scheduler.
	 */
	async act(wave: number, calls: ToolCall[]): Promise<Acted> {
		const prepared = calls.map((call, i): Prepared => {
			const key = resultKey(wave, i);
			const missing = this.missingArgs(call);
			if (missing.length) return { call, entry: { tool: call.tool, key, error: skipMessage(call.tool, missing) }, skipped: true };
			let args: Record<string, unknown>;
			try {
				args = resolveArgRefs(call.args, this.memory);
			} catch (error) {
				return { call, entry: { tool: call.tool, key, error: messageOf(error) } };
			}
			return call.tool === PEEK_TOOL ? { call, entry: this.peek(key, args) } : { call, args };
		});

		const runnable = prepared.flatMap((p) => ('args' in p ? [{ tool: p.call.tool, args: p.args }] : []));
		const outcomes = await runWave(runnable, (call) => this.exec(call), { timeoutMs: (tool) => this.limit(tool), late: this.late });

		let next = 0;
		const entries = prepared.map((p, i) => {
			if ('entry' in p) return this.withCall(p.entry, p.call);
			const key = resultKey(wave, i);
			const outcome = outcomes[next++];
			return this.withCall(outcome.ok ? this.store(p.call.tool, key, outcome.result) : { tool: p.call.tool, key, error: outcome.error }, p.call);
		});
		return { entries, skipped: prepared.map((p) => 'skipped' in p) };
	}

	/**
	 * The required arguments a call leaves out, in the order its tool's schema
	 * lists them. Only undefined or null is missing: an empty string is an
	 * argument (list_directory takes '' for the root). A tool the loop does not
	 * know has none missing, so it fails as unknown when it runs.
	 */
	private missingArgs(call: ToolCall): string[] {
		const tool = call.tool === PEEK_TOOL ? MEMORY_PEEK_TOOL : this.tools.get(call.tool);
		const required = tool?.parameters.required;
		if (!Array.isArray(required)) return [];
		return required.filter((name): name is string => typeof name === 'string' && (call.args[name] === undefined || call.args[name] === null));
	}

	/** Runs one call on its tool. */
	private exec(call: ToolCall): Promise<string> {
		const tool = this.tools.get(call.tool);
		if (!tool) throw new Error(`Unknown tool '${call.tool}'. Use only the tools in Available Tools.`);
		return tool.execute(call.args);
	}

	/** A tool's time limit: the option's when it is a positive number, else the default. */
	private limit(tool: string): number {
		const ms = this.o.timeoutMs?.(tool);
		return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : TOOL_TIMEOUT_MS;
	}

	/** Runs a memory.peek call. Its result is shown, not stored. */
	private peek(key: string, args: Record<string, unknown>): Entry {
		try {
			return { tool: PEEK_TOOL, key, ...(JSON.parse(peek(this.memory, args)) as Omit<Entry, 'tool' | 'key'>) };
		} catch (error) {
			return { tool: PEEK_TOOL, key, error: messageOf(error) };
		}
	}

	/**
	 * Stores a result and builds its entry. A result identical to one already
	 * stored says so: it never blocks, as repeating a call is often legitimate,
	 * but it tells the model the call brought nothing new. A check that passes
	 * again is news, not a repeat.
	 */
	private store(tool: string, key: string, result: string): Entry {
		this.memory.put(key, result);
		const entry: Entry = { tool, key, summary: summarize(result) };
		if (tool === CHECK_TOOL) return entry;
		const prior = setDefault(this.seenResults, result, key);
		if (prior === key) return entry;
		entry.deduplicated = true;
		entry.note = `This result is identical to ${prior}, which is already in memory, so this call produced no new information. Read ${prior} with memory.peek, or change approach: repeating a call that returns the same data will not advance the task.`;
		return entry;
	}

	/**
	 * Puts a short form of the call's arguments beside its entry, as the model
	 * wrote them, and points out a call identical to an earlier one. The note
	 * informs and never blocks: reading a file again after writing it is
	 * legitimate. A check run again is what the rules ask for, so it is never a repeat.
	 */
	private withCall(entry: Entry, call: ToolCall): Entry {
		const { tool, key, ...rest } = entry;
		const shown: Entry = { tool, key };
		if (Object.keys(call.args).length) shown.args = previewArgs(call.args);
		Object.assign(shown, rest);
		if (call.tool === CHECK_TOOL) return shown;
		const first = setDefault(this.seenCalls, canonical({ tool: call.tool, args: call.args }), key);
		if (first !== key && this.removed.has(first)) {
			// Read, remove, read again: the model dropped data it still needed.
			shown.note = `Same tool and arguments as ${first}, whose result you removed. If you still need data from a result, keep it in scratch before you remove the result.`;
		} else if (first !== key) {
			// A note that the result is identical already says more.
			shown.note ??= `Same tool and arguments as ${first}.`;
		}
		return shown;
	}

	/** The keys of the entries from earlier waves. */
	earlierKeys(): Set<string> {
		return new Set(this.results.map((entry) => entry.key));
	}

	/** Adds a wave's entries to what the next question shows. */
	record(entries: Entry[]): void {
		this.results.push(...entries);
	}

	/**
	 * Forgets which stored results the keys hold, as soon as a reply asks to
	 * remove them, so no identical-result note made in this wave names a key
	 * about to go. Which calls they answered is kept: a repeat of a removed call
	 * is worth pointing out.
	 */
	forget(keys: string[]): void {
		const gone = new Set(keys);
		for (const [text, key] of this.seenResults) if (gone.has(key)) this.seenResults.delete(text);
	}

	/** Removes keys from memory and their entries from the next question. */
	remove(keys: string[]): void {
		const gone = new Set(keys);
		this.memory.clear(keys);
		for (const key of keys) this.removed.add(key);
		this.results = this.results.filter((entry) => !gone.has(entry.key));
	}

	/**
	 * Counts a timed-out call that has returned since the last look as a change
	 * in this wave: what it did may have landed after a check read the work.
	 */
	noteLateReturns(wave: number): void {
		let returned = false;
		for (const running of this.watched) {
			if (this.late.has(running)) continue;
			this.watched.delete(running);
			returned = true;
		}
		for (const running of this.late) this.watched.add(running);
		if (returned) this.lastChange = wave;
	}

	/**
	 * Why the run may not finish yet, or null if it may. A timed-out call still
	 * running may still change the work, so no check covers it. Otherwise the
	 * last change must be followed by a passing check in a later wave: a check
	 * in the same wave ran alongside the change and may have read the work
	 * before the change landed.
	 */
	notChecked(): string | null {
		if (this.late.size) {
			return `Not finished: ${this.late.size} call(s) that timed out are still running and may still change the work. A check cannot cover them yet; call ${CHECK_TOOL} again after they end.`;
		}
		if (this.lastChange >= 0 && this.lastCheck <= this.lastChange) {
			return `Not finished: call ${CHECK_TOOL} on its own, after your last change, and fix what it reports before done=true.`;
		}
		return null;
	}

	/** The planned wave's raw replies as one detail text, or undefined when not recording or no reply arrived. */
	private waveDetail(): string | undefined {
		const [first, retry] = this.waveReplies;
		return first === undefined ? undefined : joinReplies(first, retry);
	}

	/**
	 * Sends a wave's thinking chunk: its thought, then a line per call; nothing
	 * when both are empty. When recording, the chunk carries the wave's raw
	 * replies, and goes out even with nothing else to say (as `Model reply`),
	 * as an unusable reply is the one most worth reading.
	 */
	think(thought: string, lines: string[]): void {
		const text = [...(thought.trim() ? [thought] : []), ...lines].join('\n');
		const detail = this.waveDetail();
		if (text || detail !== undefined) this.o.emit('thinking', text || BARE_REPLY_ROW, detail);
	}

	/** When recording, sends the accepted wave's raw replies as their own row, ahead of the answer. */
	thinkFinal(): void {
		const detail = this.waveDetail();
		if (detail !== undefined) this.o.emit('thinking', FINAL_REPLY_ROW, detail);
	}

	/** The run's result. */
	finish(stopReason: StopReason, answer: string, waves: number): LoopResult {
		return { answer, stopReason, waves, changed: this.lastChange >= 0, modelMs: this.modelMs };
	}

	/**
	 * Asks for a best-effort answer from what was gathered (Wave's
	 * `_synthesize`): a plain question, not a plan, with the results as lines
	 * and the model's notes. If that call fails or returns nothing, the answer
	 * is the gathered facts as they stand.
	 */
	async bestEffort(): Promise<string> {
		const lines = this.results.map(gatheredLine);
		const context = [`Information gathered:\n${lines.length ? lines.join('\n') : '(no results gathered)'}`];
		// The notes hold what the model worked out (counts, names, conclusions).
		if (this.scratch) context.push(`Your working notes from the steps so far:\n${this.scratch}`);
		const q: QuestionSpec = {
			role: FALLBACK_ROLE,
			instructions: [],
			history: [...this.o.history],
			goals: [this.o.request],
			context,
			question: FALLBACK_QUESTION,
			expectJson: false,
			cachePrefix: false,
		};
		let answer: string;
		try {
			answer = await this.ask(q);
		} catch (error) {
			const name = error instanceof Error ? error.name : 'Error';
			return partialReport(`the model call failed (${name}: ${messageOf(error)})`, lines, this.scratch);
		}
		if (this.o.recordReplies) this.o.emit('thinking', BEST_EFFORT_ROW, capReply(answer));
		if (!answer.trim()) return partialReport('the model returned no text', lines, this.scratch);
		return answer;
	}
}

// =============================================================================
// LOOP — the entry point
// =============================================================================

/**
 * Runs waves until the model's answer is accepted, a reply stays unusable
 * after one retry (`empty_plan`), or the model cannot be reached (`error`).
 * Each wave plans, runs its calls, and records their entries for the next
 * question. A done=true is sent back, with the reason in an entry, until a
 * check has passed in a wave after the last change. Every wave sends one
 * thinking chunk except the one whose answer is accepted, which goes out as
 * the answer instead. With `recordReplies`, each chunk also carries its raw
 * model reply, the accepted wave's reply goes out as one extra chunk before
 * the answer, and so does the best-effort answer's.
 *
 * @param o - The run's request, prompt start, tools, model and hooks.
 * @returns The answer and how the run ended.
 * @throws The model's error when it fails before anything was gathered.
 */
export async function runLoop(o: LoopOptions): Promise<LoopResult> {
	const run = new WaveRun(o);
	for (let wave = 0; ; wave++) {
		o.ledger.beginWave(wave);
		let reply: PlanReply;
		try {
			reply = await run.plan();
		} catch (error) {
			// Nothing gathered: the cause (a bad key, a stopped pipeline) is the useful part.
			if (!run.gathered) throw error;
			return run.finish('error', await run.bestEffort(), wave + 1);
		}
		const { toolCalls } = reply;

		// step: done with nothing to run — the answer stands unless the work is unchecked
		if (reply.done && !toolCalls.length) {
			run.noteLateReturns(wave);
			const refused = run.notChecked();
			if (!refused) {
				run.thinkFinal();
				return run.finish('done', resolveAnswerRefs(reply.answer, run.memory), wave + 1);
			}
			// Its remove list is not applied: the answer it sends again may still need those keys.
			run.record([refusal(wave, refused), ...problemEntries(wave, reply.problems)]);
			run.think(reply.thought, []);
			continue;
		}

		// step: still unusable after the retry — record why, then answer from what was gathered
		if (!toolCalls.length) {
			run.record(reply.problems.map((problem, i) => ({ tool: 'reply-check', key: `wave-${wave}.check${i}`, error: `Skipped: ${problem}` })));
			run.think(reply.thought, []);
			return run.finish('empty_plan', await run.bestEffort(), wave + 1);
		}

		// step: run the calls. Only earlier waves' keys can be removed, and a reply
		// asking to finish keeps its keys in case it is sent back.
		const earlier = run.earlierKeys();
		const removing = reply.askedDone ? [] : reply.remove.filter((key) => earlier.has(key));
		run.forget(removing);
		const { entries, skipped } = await run.act(wave, toolCalls);
		const lines = toolCalls.map((call, i) => thinkingLine(call, entries[i]));
		entries.push(...problemEntries(wave, reply.problems));

		// step: track change and check. A change counts even when it failed: a
		// write may have landed before its error. The newest check decides: a
		// check that failed, or any check call that errored (it threw, timed out,
		// or never ran), leaves the work unchecked, whatever passed before. A
		// timed-out check may still record a pass, but the model never saw it.
		// A call skipped for missing arguments never touched the work or the
		// check, so it counts as neither.
		if (toolCalls.some((call, i) => !skipped[i] && call.tool !== PEEK_TOOL && o.isChange(call.tool))) run.lastChange = wave;
		const checked = o.ledger.endWave();
		const checkErred = toolCalls.some((call, i) => !skipped[i] && call.tool === CHECK_TOOL && entries[i].error !== undefined);
		if (checked === 'fail' || checkErred) run.lastCheck = -1;
		else if (checked === 'pass') run.lastCheck = wave;
		run.noteLateReturns(wave);

		// step: done with calls — the answer stands only if every call worked, the
		// model has read any check it ran, and the work is checked
		let finished = reply.done && !entries.some((entry) => entry.error !== undefined);
		if (finished && toolCalls.some((call) => call.tool === CHECK_TOOL)) {
			finished = false;
			entries.push(refusal(wave, READ_THE_CHECK));
		} else if (finished) {
			const refused = run.notChecked();
			if (refused) {
				finished = false;
				entries.push(refusal(wave, refused));
			}
		}
		run.record(entries);
		if (finished) {
			run.thinkFinal();
			return run.finish('done', resolveAnswerRefs(reply.answer, run.memory), wave + 1);
		}

		run.think(reply.thought, lines);
		if (removing.length) run.remove(removing);
	}
}
