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
// CHECK — the check tool, its ledger, and the evidence a check leaves behind
// =============================================================================

import { AgentTool, AgentToolkit } from '../tools';

// =============================================================================
// CHECK TYPES — the evidence a check leaves behind
// =============================================================================

/** How one check step ended. */
export type CheckStatus = 'pass' | 'fail' | 'not_run';

/** What one check step ran and saw. */
export interface CheckEvidence {
	/** Step name, such as 'types' or 'build'. */
	step: string;
	/** What was run, as a short phrase. */
	ran: string;
	/** The raw output the step produced. */
	output: string;
	/** How the step ended. */
	status: CheckStatus;
	/** One line the model can act on. */
	summary: string;
}

/** The evidence from checking one app or pipeline. */
export interface CheckReport {
	/** What kind of thing was checked. */
	kind: 'app' | 'pipeline';
	/** The app id or pipeline path that was checked. */
	target: string;
	/** One entry per step, in the order they ran. */
	evidence: CheckEvidence[];
}

/** Checks one kind of target and reports what it saw. */
export interface Checker {
	/** What kind of target this checker handles. */
	readonly kind: 'app' | 'pipeline';
	/**
	 * Runs the checks against a target.
	 *
	 * @param target - The app id or pipeline path.
	 * @param args - Extra arguments the model passed to the check tool.
	 * @returns The evidence from every step.
	 */
	check(target: string, args: Record<string, unknown>): Promise<CheckReport>;
}

/**
 * Whether a report counts as passing. A step that did not run is not a
 * failure; only a step that ran and failed is.
 *
 * @param report - The report to judge.
 * @returns True when no evidence has status 'fail'.
 */
function reportPassed(report: CheckReport): boolean {
	return report.evidence.every((e) => e.status !== 'fail');
}

// =============================================================================
// CHECK LEDGER — what was checked, per wave and per target
// =============================================================================

/** How one wave went as far as checking is concerned. */
export type WaveCheckOutcome = 'pass' | 'fail' | 'none';

/**
 * The record of every check the check tool ran. Only the tool writes to it,
 * so it holds tool results and nothing the model said. The loop reads it
 * two ways: per wave (did this wave check, and did it pass), and as the
 * newest report for each target (what the answer's checks line is built from).
 */
export class CheckLedger {
	/** Every report in the order it was recorded, tagged with its wave. */
	private readonly log: Array<{ wave: number; report: CheckReport }> = [];
	/** The wave now running. */
	private wave = -1;

	/**
	 * Starts a wave. Reports recorded from here on belong to it.
	 *
	 * @param wave - The wave number.
	 */
	beginWave(wave: number): void {
		this.wave = wave;
	}

	/**
	 * Records one check's report against the current wave.
	 *
	 * @param report - What the checker saw.
	 */
	record(report: CheckReport): void {
		this.log.push({ wave: this.wave, report });
	}

	/**
	 * Judges the current wave.
	 *
	 * @returns 'none' when no check ran this wave, 'fail' when any check this
	 *   wave failed (even if a later one passed), otherwise 'pass'.
	 */
	endWave(): WaveCheckOutcome {
		const reports = this.log.filter((e) => e.wave === this.wave).map((e) => e.report);
		if (reports.length === 0) return 'none';
		return reports.every(reportPassed) ? 'pass' : 'fail';
	}

	/**
	 * The newest report for each target, across all waves.
	 *
	 * @returns One report per target, in the order the targets were first checked.
	 */
	latestByTarget(): CheckReport[] {
		const latest = new Map<string, CheckReport>();
		for (const { report } of this.log) latest.set(report.target, report);
		return [...latest.values()];
	}
}

// =============================================================================
// CHECKS LINE — the sentence the code adds to the final answer
// =============================================================================

/**
 * Builds the checks line from the actual check results. The model never
 * writes or edits it. One report reads "Checked: a · b"; several are labeled
 * by target and separated by semicolons.
 *
 * @param reports - The newest report per target.
 * @returns The line, or '' when there is nothing to report.
 */
export function checksLine(reports: CheckReport[]): string {
	// step: one group per report, skipping any that has nothing to say
	const groups = reports
		.map((r) => ({
			target: r.target,
			text: r.evidence
				.map((e) => e.summary)
				.filter((s) => s.length > 0)
				.join(' · '),
		}))
		.filter((g) => g.text.length > 0);
	if (groups.length === 0) return '';
	// step: a lone group needs no label
	if (groups.length === 1) return `Checked: ${groups[0].text}`;
	return `Checked: ${groups.map((g) => `${g.target}: ${g.text}`).join('; ')}`;
}

// =============================================================================
// CHECK TOOL — the one way the agent gets evidence that its work holds up
// =============================================================================

/** The kinds of target the check tool accepts. */
const CHECK_KINDS = ['app', 'pipeline'] as const;

/** System-prompt fragment for the check tool. */
const CHECK_INSTRUCTIONS = `## Checking

- Run \`check\` after your last change and before you say you're done, because only a check run after the last change counts as evidence.
- If a check fails, fix what it reports and run \`check\` again, because an answer with a failing check is sent back.
- Leave the "Checked:" line to the system, because it is built from the check results and anything you write there is dropped.`;

/** What the model reads about the tool: when to use it, when not to, one example. */
const CHECK_DESCRIPTION = `Run the full check on an app or a pipeline and record what it saw. The result lists every step that ran, its output, and whether it passed.

Use it:
- after your last change to an app or pipeline, before you tell the user you're done;
- again after fixing a failed check.

Don't use it:
- to read state: use read_file or list_directory to see what a file holds;
- after each small edit: saving an app file already returns its type errors, and saving a pipeline already validates it.

Steps that could not run (for example, "preview closed: build not checked") are named in the result; say so plainly in your answer.

Example: after editing the app "daybook-ui", call check { "kind": "app", "target": "daybook-ui" }. For a pipeline, target is its path and input is optional text for the test run: check { "kind": "pipeline", "target": "pipelines/summarize.pipe", "input": "a short sample" }.`;

// =============================================================================
// RESULT TEXT
// =============================================================================

/**
 * Indents every line of a block by two spaces.
 *
 * @param text - The block to indent.
 * @returns The indented block.
 */
function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `  ${line}`)
		.join('\n');
}

/**
 * Writes a report as the tool result: a verdict line, then each step with
 * its output indented below. A step with no output shows its summary there,
 * so a step that did not run still says why.
 *
 * @param report - The report to write out.
 * @returns The result text.
 */
function formatReport(report: CheckReport): string {
	const lines = [`CHECK ${reportPassed(report) ? 'PASSED' : 'FAILED'}: ${report.target}`];
	for (const e of report.evidence) {
		lines.push(`- [${e.status}] ${e.step}: ran ${e.ran}`);
		const body = e.output.trim() || e.summary.trim();
		if (body) lines.push(indent(body));
	}
	return lines.join('\n');
}

// =============================================================================
// CHECK TOOLKIT
// =============================================================================

/**
 * The `check` tool. It sends each call to the checker for that kind of
 * target and records the report in the ledger, so the loop can tell whether
 * the agent really checked and what the answer's checks line should say.
 */
export class CheckToolkit extends AgentToolkit {
	readonly name = 'check';
	readonly instructions = CHECK_INSTRUCTIONS;

	/** The mounted checkers, by the kind of target each handles. */
	private readonly checkers: Map<string, Checker>;
	/** Where every report is recorded. */
	private readonly ledger: CheckLedger;

	/**
	 * Builds the toolkit for one agent.
	 *
	 * @param checkers - One checker per kind the host can check.
	 * @param ledger - The ledger the loop reads after each wave.
	 */
	constructor(checkers: Checker[], ledger: CheckLedger) {
		super();
		this.checkers = new Map(checkers.map((c) => [c.kind, c]));
		this.ledger = ledger;
	}

	/**
	 * Runs one check.
	 *
	 * @param args - The model's arguments: kind, target, and any extras for the checker.
	 * @returns The evidence, written for the model.
	 * @throws When the call is wrong, the checker throws, or the report holds no evidence; nothing is recorded then.
	 */
	private async run(args: Record<string, unknown>): Promise<string> {
		// step: refuse a call the checkers can't act on, saying how to fix it
		const kind = String(args.kind ?? '');
		if (!(CHECK_KINDS as readonly string[]).includes(kind)) {
			throw new Error(`kind must be one of: ${CHECK_KINDS.join(', ')} (got '${kind}'). Pass kind 'app' for an app id or 'pipeline' for a pipeline path.`);
		}
		const target = typeof args.target === 'string' ? args.target.trim() : '';
		if (!target) {
			throw new Error(`target is required: pass the ${kind === 'app' ? 'app id' : 'pipeline path'} to check.`);
		}
		const checker = this.checkers.get(kind);
		if (!checker) {
			throw new Error(`No ${kind} checker is available here, so this ${kind} can't be checked. Tell the user it was not checked; don't report it as passing.`);
		}
		// step: run it, then keep the report as evidence; a report with none would read as a pass, so it is refused
		const report = await checker.check(target, args);
		if (report.evidence.length === 0) {
			throw new Error(`The ${kind} check of '${target}' returned no evidence, so nothing was checked. Tell the user it was not checked; don't report it as passing.`);
		}
		this.ledger.record(report);
		return formatReport(report);
	}

	/**
	 * The member tools.
	 *
	 * @returns The single `check` tool.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'check',
				description: CHECK_DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						kind: { type: 'string', enum: [...CHECK_KINDS], description: "What to check: 'app' or 'pipeline'" },
						target: { type: 'string', description: 'The app id, or the pipeline path' },
						input: { type: 'string', description: 'Optional text for the check to use, such as the sample a pipeline run should process' },
					},
					required: ['kind', 'target'],
					additionalProperties: false,
				},
				execute: (a) => this.run(a),
			}),
		];
	}
}
