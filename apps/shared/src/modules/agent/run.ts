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
// RUN — one agent run, assembled from the toolkits
// =============================================================================

/**
 * `runAgent` builds everything one run needs and drives the Wave loop: the
 * workspace view with the guides at `.rocketride/`, the toolkits in mount
 * order, the prompt start (built once, never changed), the model, and the
 * check ledger. It streams each wave's progress as `thinking` chunks and sends
 * the answer as one `content` chunk, with the checks line the code builds from
 * the ledger.
 *
 * Everything that only works in the browser (the model pipeline, the confirm
 * dialog, Monaco's markers) has a default here and comes in through `deps`
 * otherwise, so tests run a whole run without a browser or an engine.
 */

import { Question } from 'rocketride';
import type { ChatMessage } from 'shell';

import { appChecker } from './checks/appCheck';
import { AutoCheckToolkit, monacoMarkerSource } from './checks/appTypes';
import type { MarkerSource } from './checks/appTypes';
import { CheckLedger, CheckToolkit, checksLine } from './checks/check';
import { pipelineChecker } from './checks/pipelineCheck';
import { FilesystemTools } from './filesystem';
import { GuideFileSystem } from './guides';
import type { AgentHost } from './host';
import { CORE_PROMPT } from './prompts';
import { AppToolkit, DEPLOY_APP_TIMEOUT_MS } from './rocketride/appTools';
import { NOT_CONNECTED_MESSAGE, pipelineArg, requireClient, shellConfirm, type ClientGetter, type ConfirmFn } from './rocketride/common';
import { DeployToolkit } from './rocketride/deployTools';
import { InventoryToolkit } from './rocketride/inventory';
import { PipelineToolkit, validatePipeline } from './rocketride/pipelineTools';
import { RunToolkit } from './rocketride/runTools';
import { composeToolkits } from './tools';
import { runLoop, TOOL_TIMEOUT_MS, type LoopResult } from './wave/loop';
import { buildPrefix } from './wave/plan';
import type { AppPrompts, HistoryTurn, ModelCall, QuestionSpec } from './wave/plan';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tools whose calls change the work, so a check must pass after them before the run may finish. */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'rename', 'delete_file', 'create_app']);

/** The Pipeline Builder setting the host reads for `recordModelCalls` (declared in apps/rocket-ui/package.json). */
export const RECORD_MODEL_CALLS_SETTING = 'rocketride.pipeBuilder.agentRecordModelCalls';

/** The longest a save or a check waits for Monaco's marker source to load, in milliseconds. */
const MARKERS_LOAD_LIMIT_MS = 10_000;

/** What the answer says when work changed and the run ended before a check passed after it. */
const NOT_CHECKED = 'Not checked: the run stopped before a check passed after the last change.';

/** The start of a line the code owns, once markdown is stripped; any the model writes are dropped (spec §7). Emphasis may close before the colon (`**Checked**:`). */
const CHECKS_LINE = /^(?:Checked|Not checked)[*_]*:/;

/** The list and quote markers, emphasis and spaces a line may open with (`- `, `> `, `**`, `_`). */
const LEADING_MARKDOWN = /^[\s>*+_-]+/;

// =============================================================================
// TYPES
// =============================================================================

/** What one run is asked to do, and with what. */
export interface AgentRunOptions {
	/** The conversation before this request, as the chat renders it. */
	history: ChatMessage[];
	/** The mounting app's workspace map and guide router. */
	prompts: AppPrompts;
	/** The token of the running LLM pipeline; read again after a restart. */
	token: () => Promise<string>;
	/** Restarts the LLM pipeline after it fails. */
	onPipelineError?: () => Promise<void>;
}

/** What one run needs from its host. The optional parts have browser defaults; tests always pass them. */
export interface AgentDeps {
	/** The mounting app's workspace, guides, scaffolding and dev sessions. */
	host: AgentHost;
	/** The connected RocketRide client, or null when there is none. */
	client: ClientGetter;
	/** Asks the model one question (default: the LLM pipeline behind `options.token`). */
	model?: ModelCall;
	/** Asks the user to confirm (default: the shell's confirm dialog). */
	confirm?: ConfirmFn;
	/** Gets Monaco's marker source, or null when there is none (default: the editor's, loaded once). */
	markers?: () => Promise<MarkerSource | null>;
}

// =============================================================================
// MARKERS — the editor's marker source, loaded once and never in the way
// =============================================================================

/**
 * Wraps a marker source loader so a save or a check is never held up by it.
 * The load runs once and its source is shared. A load that fails resolves
 * null, and the next call tries again. A load still going after `limitMs`
 * resolves null for that call; later calls get the source once it arrives.
 *
 * @param load - Loads the marker source.
 * @param limitMs - The longest one call waits for the load, in milliseconds.
 * @returns A getter that resolves the source, or null when there is none yet.
 */
function guardedMarkerSource(load: () => Promise<MarkerSource>, limitMs = MARKERS_LOAD_LIMIT_MS): () => Promise<MarkerSource | null> {
	let loading: Promise<MarkerSource | null> | null = null;
	return () => {
		// step: started inside a chain, so even a loader that throws at once resolves null
		loading ??= Promise.resolve()
			.then(load)
			.catch(() => {
				loading = null;
				return null;
			});
		const pending = loading;
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), limitMs);
			void pending.then((src) => {
				clearTimeout(timer);
				resolve(src);
			});
		});
	};
}

/** Monaco's marker source for every run in this page; it loads Monaco the first time a save or a check asks. */
const editorMarkers = guardedMarkerSource(monacoMarkerSource);

// =============================================================================
// HISTORY AND ANSWER
// =============================================================================

/**
 * Turns the chat's messages into the model's history: what the user said and
 * the answers the agent gave. Thinking rows (bot rows with a result key),
 * error banners, and system and status rows are not part of the conversation.
 *
 * @param messages - The chat's messages, oldest first.
 * @returns The history turns, oldest first.
 */
function toHistory(messages: ChatMessage[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const m of messages) {
		if (m.sender === 'user') turns.push({ role: 'user', content: m.text });
		else if (m.sender === 'bot' && !m.isError && !m.resultKey) turns.push({ role: 'assistant', content: m.text });
	}
	return turns;
}

/**
 * Whether a line of the model's answer is one of the lines the code owns.
 *
 * @param line - One line of the answer.
 * @returns True when, past any leading list or quote marker and emphasis, it starts with "Checked:" or "Not checked:" (so `- **Checked:** …` counts).
 */
function isChecksLine(line: string): boolean {
	return CHECKS_LINE.test(line.replace(LEADING_MARKDOWN, ''));
}

/**
 * The text the user reads: the model's answer, then the checks line built from
 * the ledger, then a warning when the run changed the work and stopped before
 * finishing. Lines in the answer that start with "Checked:" or "Not checked:",
 * markdown-wrapped or not, are dropped, because only the code writes those.
 *
 * @param result - How the loop ended.
 * @param ledger - Every check the run recorded.
 * @returns The answer, its checks line and any warning, separated by blank lines.
 */
function finalText(result: LoopResult, ledger: CheckLedger): string {
	const answer = result.answer
		.split('\n')
		.filter((line) => !isChecksLine(line))
		.join('\n')
		.trim();
	const parts = [answer, checksLine(ledger.latestByTarget())];
	if (result.changed && result.stopReason !== 'done') parts.push(NOT_CHECKED);
	return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * The median of some timings.
 *
 * @param values - The timings, in milliseconds.
 * @returns The middle value (the mean of the middle two for an even count), rounded; 0 when there are none.
 */
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

// =============================================================================
// CHAT MODEL — one model call, asked on the LLM pipeline's token
// =============================================================================

/**
 * Each model call is `client.chat({ token, question })` on the token of the
 * LLM pipeline: text in, a JSON plan out. A provider that fails does not make
 * `chat` throw; the pipeline answers with text starting "**LLM error** —".
 * This section turns that answer, a dead token, and an empty reply into errors
 * the loop can show as a banner, and times every round trip.
 */

// =============================================================================
// ERRORS
// =============================================================================

/** The start of the answer the LLM pipeline writes when the provider call failed (packages/ai/src/ai/common/llm_base.py:95). */
const LLM_ERROR_PREFIX = '**LLM error** — ';

/** Why a model call failed: the provider rejected it, the pipeline died, or nothing came back. */
class ModelError extends Error {
	/**
	 * @param message - What went wrong, readable as it stands.
	 * @param kind - 'provider' when the model call inside the pipeline failed, 'pipeline' when
	 *   the pipeline stopped responding, 'empty' when it answered with nothing.
	 */
	constructor(
		message: string,
		readonly kind: 'provider' | 'pipeline' | 'empty'
	) {
		super(message);
		this.name = 'ModelError';
	}
}

// =============================================================================
// THE CALL
// =============================================================================

/** The part of the RocketRide client a model call needs. */
export interface ChatClient {
	/**
	 * Asks the pipeline behind `token` one question.
	 *
	 * @param o - The pipeline token and the question to send.
	 * @returns The pipeline result, with the model's text in `answers`. Its other
	 *   fields depend on the pipeline; the index signature lets the client's
	 *   `PIPELINE_RESULT` fit, which an all-optional type would refuse.
	 */
	chat(o: { token: string; question: unknown }): Promise<{ answers?: unknown[]; [field: string]: unknown }>;
}

/** What createChatModel needs from its host. */
export interface ChatModelOptions {
	/** The connected client, or null when there is none. */
	client: () => ChatClient | null;
	/** The token of the running LLM pipeline. Read again after a restart, since a new pipeline has a new token. */
	token: () => Promise<string>;
	/** Turns a question into whatever `client.chat` takes. */
	toQuestion: (q: QuestionSpec) => unknown;
	/** Restarts the LLM pipeline. Called once per model call, when the pipeline fails the first time. */
	onPipelineError?: () => Promise<void>;
}

/**
 * Builds the model call the Wave loop uses.
 *
 * The call resolves with the model's text, or rejects: a missing client with a
 * plain Error, anything else with a ModelError. A pipeline failure gets one
 * restart (`onPipelineError`) and one retry; a second failure is final.
 *
 * @param o - The client, token and hooks the host supplies.
 * @returns The model call.
 */
function createChatModel(o: ChatModelOptions): ModelCall {
	return async (q) => {
		const client = o.client();
		if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
		const question = o.toQuestion(q);

		const ask = async (): Promise<{ answers?: unknown[] }> => client.chat({ token: await o.token(), question });

		const started = performance.now();
		try {
			let result: { answers?: unknown[] };
			try {
				result = await ask();
			} catch (first) {
				if (!o.onPipelineError) throw pipelineError(first);
				try {
					await o.onPipelineError();
					result = await ask();
				} catch (second) {
					throw pipelineError(second);
				}
			}
			return answerText(result);
		} finally {
			const ms = Math.round(performance.now() - started);
			console.log(`[agent] model call ${ms} ms`);
		}
	};
}

/** Wraps a failed chat call in the error the user reads. */
function pipelineError(cause: unknown): ModelError {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new ModelError(`The model pipeline stopped responding: ${reason}`, 'pipeline');
}

/** Pulls the model's text out of a pipeline result, or throws the error it stands for. */
function answerText(result: { answers?: unknown[] }): string {
	const first = result.answers?.[0];
	const text = typeof first === 'string' ? first : first == null ? '' : JSON.stringify(first);
	if (text.trim() === '') throw new ModelError('The model returned no answer.', 'empty');
	if (text.startsWith(LLM_ERROR_PREFIX)) {
		throw new ModelError(`The model provider failed: ${text.slice(LLM_ERROR_PREFIX.length)}`, 'provider');
	}
	return text;
}

// =============================================================================
// THE QUESTION
// =============================================================================

/**
 * Builds the client's Question from a spec. This is the only runtime import of
 * 'rocketride' in the agent; under shared:test it is undefined, so tests pass
 * a fake `toQuestion` to createChatModel instead of calling this.
 *
 * @param q - The question to send.
 * @returns The client's Question, in the order Wave's prompt expects.
 */
function toRocketRideQuestion(q: QuestionSpec): Question {
	const question = new Question({ expectJson: q.expectJson, cachePrefix: q.cachePrefix, role: q.role });
	for (const { title, text } of q.instructions) question.addInstruction(title, text);
	for (const turn of q.history) question.addHistory({ role: turn.role, content: turn.content });
	for (const goal of q.goals) question.addGoal(goal);
	for (const item of q.context) question.addContext(item);
	question.addQuestion(q.question);
	return question;
}

// =============================================================================
// RUN
// =============================================================================

/**
 * Runs the agent once on a request. Progress goes to the callback as
 * `thinking` chunks, one per wave except the wave whose answer is accepted,
 * and the answer goes as one `content` chunk. One summary line is logged.
 * When the host's `recordModelCalls` says yes, each thinking chunk also
 * carries its wave's raw model reply as `detail`, and the accepted answer
 * (and a best-effort one) gets one extra thinking chunk for its own reply.
 *
 * @param request - What the user asked for.
 * @param callback - Receives each chunk as (type, content, detail?).
 * @param options - The conversation so far, the app's prompts and the model pipeline's token.
 * @param deps - The host, the client getter, and the parts tests replace.
 * @throws The model's error when it fails before the run gathered anything.
 */
export async function runAgent(request: string, callback: (type: string, content: string, detail?: string) => void, options: AgentRunOptions, deps: AgentDeps): Promise<void> {
	const { host, client } = deps;
	const model = deps.model ?? createChatModel({ client, token: options.token, toQuestion: toRocketRideQuestion, onPipelineError: options.onPipelineError });
	const confirm = deps.confirm ?? shellConfirm();
	const markers = deps.markers ?? editorMarkers;
	// step: whether this request records the model's raw replies, read now so a settings change applies to the next message
	const recordReplies = host.recordModelCalls?.() === true;

	// step: the workspace with the guides; one file toolkit per run, so reads never carry over
	const vfs = new GuideFileSystem(host.vfs, host.guides);
	const files = new FilesystemTools(vfs);
	const ledger = new CheckLedger();

	// step: mount order matters: auto-check replaces the file tools' write_file and edit_file
	const composed = composeToolkits([
		files,
		new AutoCheckToolkit(files.tools(), {
			vfs,
			markers,
			validate: (path) => pipelineArg({ path }, vfs).then(({ pipeline }) => validatePipeline(requireClient(client), pipeline)),
		}),
		new InventoryToolkit(vfs, (id) => host.devSession(id) !== null),
		new PipelineToolkit(client, vfs),
		new RunToolkit(client, vfs),
		new DeployToolkit(client, vfs, confirm),
		new AppToolkit(client, host, confirm),
		new CheckToolkit([appChecker(host, markers), pipelineChecker(client, vfs)], ledger),
	]);

	const result = await runLoop({
		request,
		history: toHistory(options.history),
		prefix: buildPrefix(CORE_PROMPT, options.prompts, composed),
		tools: composed.tools,
		model,
		ledger,
		isChange: (tool) => CHANGE_TOOLS.has(tool),
		emit: (type, text, detail) => callback(type, text, detail),
		recordReplies,
		timeoutMs: (tool) => (tool === 'deploy_app' ? DEPLOY_APP_TIMEOUT_MS : TOOL_TIMEOUT_MS),
	});

	callback('content', finalText(result, ledger));
	console.log(`[agent] stop=${result.stopReason} waves=${result.waves} modelCalls=${result.modelMs.length} medianMs=${median(result.modelMs)} guides=[${[...vfs.guidesRead].join(',')}]`);
}
