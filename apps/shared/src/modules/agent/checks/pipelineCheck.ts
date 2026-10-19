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
// PIPELINE CHECK — validate, run with sample input, wait, then the run log
// =============================================================================

/**
 * The checker behind `check { kind: 'pipeline' }`. It leaves three pieces of
 * evidence, each with what ran, its output and pass, fail or not_run:
 *
 * 1. `validate`: the engine's own rules (the same call `validate_pipeline` makes).
 * 2. `run`: start the pipeline, send the sample input, wait for the result.
 * 3. `log`: read this run's events and count the ones that report an error.
 *
 * What counts as what, because a check that wrongly passes lets the agent claim
 * unverified success and one that cannot pass on a fine pipeline leaves it stuck:
 *
 * - `fail` is only a run that went wrong: the engine refused to start it, the
 *   input errored, the reply carries an error (a node raised while processing
 *   it: the engine still answers the send successfully), the status lists errors
 *   or a non-zero exit, or the log holds error events.
 * - `not_run` is anything the check could not judge: a source that takes files, a
 *   run that did not settle in time, a status or log that could not be read, a
 *   task that someone else cancelled, a log with no flow events yet. It never
 *   counts against the pipeline, and its summary says what was not checked.
 * - Only `webhook` and `chat` sources take text, so only they are run. The source is
 *   found the way the engine finds it: the top-level `source`, or else the one
 *   component whose `config.mode` is `Source`.
 * - A text source never finishes by itself: it waits for the next input. Its
 *   `send` reply is the result, so a task that is up with a clean reply and a
 *   clean status counts as a finished run; waiting out the clock would make
 *   every such pipeline `not_run`.
 *
 * The engine allows one live task per pipeline, and a dev task is the user's own
 * slot: a run started from the canvas looks the same as one the agent started.
 * So the check never stops a task it did not start. When the pipeline is already
 * running it records `not_run` and says how to clear the run. The task the check
 * starts is always stopped.
 *
 * Every output goes through `toolText`, so secrets are stripped and a long
 * result is cut, the same as the run tools. Summaries that carry error text get
 * the raw text on one short line; the full text is in the output.
 */

import type { LogStreamRef, PipelineConfig, RocketRideClient, TASK_STATUS } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { brief, componentsOf, firstText, isJsonObject, markedSourceIds, messageOf, pipelineArg, requireClient, sleep, sourceIdOf, toolText, type ClientGetter, type JsonObject } from '../rocketride/common';
import { validatePipeline } from '../rocketride/pipelineTools';
import type { CheckEvidence, CheckReport, CheckStatus, Checker } from './check';

// =============================================================================
// CONSTANTS
// =============================================================================

/** How long a run may take before it is called still going, in milliseconds. */
const DEFAULT_RUN_WAIT_MS = 120_000;

/** The wait between status polls, in milliseconds. */
const DEFAULT_POLL_MS = 1000;

/** The sample input when the model passes none. */
const DEFAULT_INPUT = 'test';

/** The type the sample input is sent as. */
const INPUT_MIMETYPE = 'text/plain';

/** The source providers that take text. Any other source needs files or something else. */
const TEXT_SOURCES = new Set(['webhook', 'chat']);

/** The engine's refusal of a second run of a live task (`task_server.py`: "Pipeline is already running."). */
const ALREADY_RUNNING = /already running/i;

/** What the run output says when the pipeline is already running: whose run it is decides what to do. */
const ALREADY_RUNNING_OUTPUT = 'The pipeline is already running, and the engine allows one live run of it, so the check did not start one. The check never stops a run it did not start. If it is a run you started with run_pipeline, call terminate with its task_token (get it from list_running_pipelines) and check again. If the user started it, tell them the pipeline was not run by the check.';

/** The task state for a task that is up. The state numbers are the engine's `TASK_STATE`, kept here because the enum is not importable under the test runner. */
const STATE_RUNNING = 3;

/** The task state for a task that finished. */
const STATE_COMPLETED = 5;

/** The task state for a task that was stopped. */
const STATE_CANCELLED = 6;

/** How many of the run's last events the log evidence shows. */
const LOG_TAIL_EVENTS = 50;

/** What the run step does, as a short phrase. */
const RUN_RAN = 'start the pipeline, send the sample input, wait for the result';

/** What the log step does, as a short phrase. */
const LOG_RAN = `read the run log (last ${LOG_TAIL_EVENTS} events)`;

/** The most events one log page holds. */
const LOG_PAGE_EVENTS = 200;

/** The most pages read from one run's log; a run longer than this is not called clean. */
const LOG_MAX_PAGES = 25;

/** The most bytes one log page holds. */
const LOG_MAX_BYTES = 1_048_576;

// =============================================================================
// TYPES
// =============================================================================

/** The options of the pipeline checker. */
export interface PipelineCheckOptions {
	/** How long the run may take before it is called still going, in milliseconds (default 120 000). */
	runWaitMs?: number;
	/** The wait between status polls, in milliseconds (default 1000). Tests pass 0. */
	pollMs?: number;
}

/** How a start ended: the task, or why there is none. */
type Started = { ok: true; token: string; projectId?: string; source?: string } | { ok: false; alreadyRunning: boolean; reason: string };

/** What the wait step decided. */
interface Verdict {
	/** How the run ended. */
	status: CheckStatus;
	/** The summary line. */
	summary: string;
	/** A note for the output, when the verdict needs explaining. */
	note?: string;
}

// =============================================================================
// EVIDENCE
// =============================================================================

/**
 * A piece of evidence for a step that did not run.
 *
 * @param step - The step name.
 * @param ran - What would have run.
 * @param summary - Why it did not, and what was not checked.
 * @returns The evidence.
 */
function notRun(step: string, ran: string, summary: string): CheckEvidence {
	return { step, ran, output: '', status: 'not_run', summary };
}

/**
 * The part of a status the evidence keeps.
 *
 * @param status - The engine's status for the task.
 * @returns The state, exit and the errors and warnings.
 */
function statusOutput(status: Partial<TASK_STATUS>): Record<string, unknown> {
	return { state: status.state, completed: status.completed, exitCode: status.exitCode, exitMessage: status.exitMessage, errors: status.errors ?? [], warnings: status.warnings ?? [] };
}

/**
 * Races some work against a time limit, and always clears the timer.
 *
 * @param work - The work.
 * @param ms - The most milliseconds to wait for it.
 * @returns The work's value, or `timedOut` when the time ran out first.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
	});
	try {
		return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), late]);
	} finally {
		clearTimeout(timer);
	}
}

// =============================================================================
// VALIDATE
// =============================================================================

/**
 * Validates the pipeline the way `validate_pipeline` does.
 *
 * @param client - The connected client.
 * @param pipeline - The flat pipeline config.
 * @param target - The pipeline path, for the step's description.
 * @returns The evidence: pass with `validate OK`, or fail with the error count.
 */
async function validateStep(client: RocketRideClient, pipeline: JsonObject, target: string): Promise<CheckEvidence> {
	const { errors, warnings } = await validatePipeline(client, pipeline);
	const output = toolText({ ok: errors.length === 0, errors, warnings }, 'fix the first errors and validate again to see the rest');
	const ran = `validate ${target} against the engine's rules`;
	return errors.length > 0 ? { step: 'validate', ran, output, status: 'fail', summary: `validate: ${errors.length} errors` } : { step: 'validate', ran, output, status: 'pass', summary: 'validate OK' };
}

// =============================================================================
// RUN
// =============================================================================

/**
 * The provider of the pipeline's source component.
 *
 * @param pipeline - The flat pipeline config.
 * @returns The provider name; undefined when the pipeline has no resolvable source or the component is missing.
 */
function sourceProviderOf(pipeline: JsonObject): string | undefined {
	const id = sourceIdOf(pipeline);
	return id === undefined ? undefined : firstText(componentsOf(pipeline).find((component) => component.id === id)?.provider);
}

/**
 * Why a pipeline's source has no provider to judge, in the words of the not-run summary.
 *
 * @param pipeline - The flat pipeline config.
 * @returns The reason: no source, several and none named, or a named source that matches no component.
 */
function noSourceReason(pipeline: JsonObject): string {
	if (sourceIdOf(pipeline) !== undefined) return "run not checked: the pipeline's source component was not found";
	return markedSourceIds(pipeline).length === 0 ? 'run not checked: the pipeline has no source component' : 'run not checked: the pipeline has several source components and names none';
}

/**
 * Starts the pipeline. The check never stops a task it did not start, so a
 * pipeline that is already running is reported, not replaced.
 *
 * @param client - The connected client.
 * @param pipeline - The flat pipeline config.
 * @returns The task, or why there is none (and whether the cause is a live run of the same pipeline).
 */
async function startTask(client: RocketRideClient, pipeline: JsonObject): Promise<Started> {
	try {
		// Without a trace level, the run log has no flow events to count errors in.
		const started = await client.use({ pipeline: pipeline as unknown as PipelineConfig, pipelineTraceLevel: 'summary' });
		const token = firstText(started?.token);
		if (!token) return { ok: false, alreadyRunning: false, reason: 'the engine returned no task token' };
		return { ok: true, token, projectId: firstText(started.projectId, started.project_id, pipeline.project_id), source: firstText(started.source, sourceIdOf(pipeline)) };
	} catch (err) {
		const reason = messageOf(err);
		return { ok: false, alreadyRunning: ALREADY_RUNNING.test(reason), reason };
	}
}

/**
 * Judges a status read after the input was answered.
 *
 * @param status - The engine's status for the task.
 * @returns The verdict; undefined while the task is still starting or stopping.
 */
function judge(status: Partial<TASK_STATUS>): Verdict | undefined {
	const errors = Array.isArray(status.errors) ? status.errors : [];
	const state = typeof status.state === 'number' ? status.state : 0;
	const ended = status.completed === true || state === STATE_COMPLETED || state === STATE_CANCELLED;
	const exitCode = typeof status.exitCode === 'number' ? status.exitCode : 0;

	if (errors.length > 0 || (ended && exitCode !== 0)) return { status: 'fail', summary: 'pipeline run failed' };
	if (state === STATE_CANCELLED) return { status: 'not_run', summary: 'run not checked: the task was cancelled before it finished' };
	if (ended) return { status: 'pass', summary: 'pipeline run OK' };
	// A chat or webhook source never ends by itself; its reply was the result, and the status shows no errors.
	if (state === STATE_RUNNING) return { status: 'pass', summary: 'pipeline run OK', note: 'the task is up and waiting for more input, as a chat or webhook source does; the reply above is the result' };
	return undefined;
}

/**
 * Sends the sample input and waits for the run to settle.
 *
 * @param client - The connected client.
 * @param token - The check's task token.
 * @param input - The sample input.
 * @param timing - How long to wait, and how often to poll.
 * @returns The run evidence.
 */
async function sendAndWait(client: RocketRideClient, token: string, input: string, timing: Required<PipelineCheckOptions>): Promise<CheckEvidence> {
	const seconds = Math.round(timing.runWaitMs / 1000);
	const stillGoing = notRun('run', RUN_RAN, `run still going after ${seconds} s`);
	const deadline = Date.now() + timing.runWaitMs;
	const hint = 'the reply is long; log_read shows the rest of what the run did';

	// step: send the input; the reply is the pipeline's answer
	let reply: unknown;
	try {
		const sent = await within(client.send(token, input, {}, INPUT_MIMETYPE), deadline - Date.now());
		if (sent.timedOut) return { ...stillGoing, output: toolText({ input, note: 'the pipeline had not answered the input yet' }, hint) };
		reply = sent.value ?? null;
	} catch (err) {
		return { step: 'run', ran: RUN_RAN, output: toolText({ input, error: messageOf(err) }, hint), status: 'fail', summary: 'pipeline run failed' };
	}

	// step: a node that raised does not fail the send: the engine answers it with the error in the reply
	if (isJsonObject(reply) && Boolean(reply.error)) {
		const { error, ...answer } = reply;
		return { step: 'run', ran: RUN_RAN, output: toolText({ input, error, reply: answer }, hint), status: 'fail', summary: 'pipeline run failed' };
	}

	// step: read the status until it settles
	for (;;) {
		let status: Partial<TASK_STATUS>;
		try {
			status = (await client.getTaskStatus(token)) ?? {};
		} catch (err) {
			return { ...notRun('run', RUN_RAN, `run status not read: ${brief(messageOf(err))}`), output: toolText({ input, reply, error: messageOf(err) }, hint) };
		}
		const verdict = judge(status);
		if (verdict) return { step: 'run', ran: RUN_RAN, output: toolText({ input, reply, status: statusOutput(status), ...(verdict.note ? { note: verdict.note } : {}) }, hint), status: verdict.status, summary: verdict.summary };
		if (Date.now() >= deadline) return { ...stillGoing, output: toolText({ input, reply, status: statusOutput(status) }, hint) };
		await sleep(Math.min(timing.pollMs, deadline - Date.now()));
	}
}

// =============================================================================
// LOG
// =============================================================================

/**
 * Whether a log event reports an error: a component that raised while a document
 * went through it, or a run that ended in error. Console lines are not judged,
 * and the status errors are already the run step's evidence.
 *
 * @param event - One event from `log.read`.
 * @returns True for an error event.
 */
function isErrorEvent(event: unknown): boolean {
	if (!isJsonObject(event)) return false;
	const body = isJsonObject(event.body) ? event.body : {};
	if (event.event === 'apaevt_flow') return isJsonObject(body.trace) && Boolean(body.trace.error);
	if (event.event === 'apaevt_log_lifecycle') return body.action === 'run-end' && body.outcome === 'error';
	return false;
}

/**
 * Reads one run's events from its first seq to the end, a page at a time.
 *
 * @param client - The connected client.
 * @param stream - The run-log stream.
 * @param fromSeq - The first seq of the run.
 * @returns The events, and whether the whole run was read (false when the page limit was reached).
 */
async function readRun(client: RocketRideClient, stream: LogStreamRef, fromSeq: number): Promise<{ events: unknown[]; complete: boolean }> {
	const events: unknown[] = [];
	let cursor: number | undefined;
	for (let page = 0; page < LOG_MAX_PAGES; page++) {
		const result = await client.log.read(stream, { ...(cursor === undefined ? { fromSeq } : { cursor }), maxEvents: LOG_PAGE_EVENTS, maxBytes: LOG_MAX_BYTES });
		events.push(...(result?.events ?? []));
		if (typeof result?.nextSeq !== 'number') return { events, complete: true };
		cursor = result.nextSeq;
	}
	return { events, complete: false };
}

/**
 * Reads this run's log and counts the error events. The run is the newest
 * chapter of the stream, so an earlier failed run is never counted against it.
 *
 * @param client - The connected client.
 * @param projectId - The run's project id.
 * @param source - The run's source component id.
 * @returns The log evidence.
 */
async function logStep(client: RocketRideClient, projectId: string | undefined, source: string | undefined): Promise<CheckEvidence> {
	if (!projectId || !source) return notRun('log', LOG_RAN, 'log not read: the engine gave no project or source id for the run');

	const stream: LogStreamRef = { projectId, source, runKind: 'dev' };
	let events: unknown[];
	let complete: boolean;
	try {
		const { chapters } = await client.log.chapters(stream);
		const runs = (chapters ?? []).filter((chapter) => typeof chapter.beginSeq === 'number');
		if (runs.length === 0) return notRun('log', LOG_RAN, 'log not checked: no run recorded for this pipeline yet');
		const newest = runs.reduce((latest, chapter) => (chapter.beginSeq > latest.beginSeq ? chapter : latest));
		// The check's task is still up, so its chapter is the live one. An ended chapter belongs to an earlier run.
		if (typeof newest.endTime === 'number') return notRun('log', LOG_RAN, 'log not checked: the newest recorded run has already ended, so this run was not logged');
		({ events, complete } = await readRun(client, stream, newest.beginSeq));
	} catch (err) {
		return { ...notRun('log', LOG_RAN, `log not read: ${brief(messageOf(err))}`), output: toolText({ error: messageOf(err) }, 'log_read shows the run log') };
	}

	const errors = events.filter(isErrorEvent);
	const flows = events.filter((event) => isJsonObject(event) && event.event === 'apaevt_flow').length;
	const output = toolText({ events: events.slice(-LOG_TAIL_EVENTS), eventsRead: events.length, flowEvents: flows, errorEvents: errors.length, ...(complete ? {} : { note: 'the run is longer than the check reads' }) }, 'log_read pages the rest of the run log');
	if (errors.length > 0) return { step: 'log', ran: LOG_RAN, output, status: 'fail', summary: `log: ${errors.length} errors` };
	// Every live run starts with a run-begin event, so only a flow event shows the pipeline's components were logged.
	if (flows === 0) return { step: 'log', ran: LOG_RAN, output, status: 'not_run', summary: 'log not checked: no flow events recorded yet' };
	if (!complete) return { step: 'log', ran: LOG_RAN, output, status: 'not_run', summary: `log partly read: the first ${events.length} events had no errors` };
	return { step: 'log', ran: LOG_RAN, output, status: 'pass', summary: 'log clean' };
}

// =============================================================================
// CHECKER
// =============================================================================

/**
 * Builds the checker for pipelines.
 *
 * @param client - The host's client getter.
 * @param vfs - The workspace view the pipeline file is read from.
 * @param opts - `runWaitMs` (default 120 000) and `pollMs` (default 1000). Tests pass a short wait and 0.
 * @returns A checker of kind 'pipeline'. `check(target, args)` takes the `.pipe` path and an optional `args.input`; it throws, with a message that says how to fix it, when the file cannot be read, the engine is not connected, or validation cannot reach the engine (there is nothing to record as evidence).
 */
export function pipelineChecker(client: ClientGetter, vfs: IWorkspaceFileSystem, opts: PipelineCheckOptions = {}): Checker {
	const timing = { runWaitMs: opts.runWaitMs ?? DEFAULT_RUN_WAIT_MS, pollMs: opts.pollMs ?? DEFAULT_POLL_MS };

	return {
		kind: 'pipeline',
		async check(target: string, args: Record<string, unknown>): Promise<CheckReport> {
			const { pipeline } = await pipelineArg({ path: target }, vfs);
			const engine = requireClient(client);
			const report = (evidence: CheckEvidence[]): CheckReport => ({ kind: 'pipeline', target, evidence });

			// step: validate; a pipeline the engine rejects is not run
			const validated = await validateStep(engine, pipeline, target);
			if (validated.status === 'fail') return report([validated, notRun('run', RUN_RAN, 'run skipped: validate failed'), notRun('log', LOG_RAN, 'log skipped: validate failed')]);

			// step: only a webhook or chat source takes the sample text
			const provider = sourceProviderOf(pipeline);
			if (provider === undefined || !TEXT_SOURCES.has(provider)) {
				const why = provider === undefined ? noSourceReason(pipeline) : `run not checked: ${provider} source needs other input`;
				return report([validated, notRun('run', RUN_RAN, why), notRun('log', LOG_RAN, 'log not checked: nothing was run')]);
			}

			// step: start, send, wait and read the log, then stop the task the check started whatever happened
			const started = await startTask(engine, pipeline);
			if (!started.ok) {
				const run: CheckEvidence = started.alreadyRunning ? { ...notRun('run', RUN_RAN, 'run not checked: the pipeline is already running'), output: ALREADY_RUNNING_OUTPUT } : { step: 'run', ran: RUN_RAN, output: toolText({ error: `Not started: ${started.reason}` }, 'validate_pipeline and the engine log say more'), status: 'fail', summary: 'pipeline run failed' };
				return report([validated, run, notRun('log', LOG_RAN, 'log not checked: nothing was run')]);
			}

			const input = typeof args.input === 'string' && args.input.trim() !== '' ? args.input : DEFAULT_INPUT;
			let run: CheckEvidence;
			let log: CheckEvidence;
			let stopFailure: string | undefined;
			try {
				run = await sendAndWait(engine, started.token, input, timing);
				log = await logStep(engine, started.projectId, started.source);
			} finally {
				stopFailure = await engine.terminate(started.token).then(
					() => undefined,
					(err: unknown) => messageOf(err)
				);
			}
			if (stopFailure) run = { ...run, output: `${run.output}\n[note] could not stop the check's task: ${stopFailure}` };
			return report([validated, run, log]);
		},
	};
}
