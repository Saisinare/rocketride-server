// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE EDITOR OPS — declarations for the pipeline page's host verbs
// =============================================================================
//
// The pipeline editor (the .pipe custom editor) is a bus realm; these are
// the verbs only its HOST can serve: document I/O (save), run/stop with the
// host's policy injection (trace level, ttl, the save-for-run suppression,
// the subscription gate), and the bridged link panel. DECLARATIONS ONLY —
// the VS Code implementation lives with the editor provider.
//
// IDENTITY: `doc` is the DOCUMENT URI STRING — the panel's stable identity.
// The pipeline's projectId is content-derived and mutable (edited project_id
// fields reassign it mid-session), so it is never a wire key.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';

/** The pipeline editor's host-verb op map. */
export interface PipelineHostOpMap extends ShellOpMap {
	/** Runs (or restarts) the document's pipeline: the host saves first
	 *  (untitled documents drive the OS Save dialog; a cancelled dialog
	 *  cancels the run), injects run policy, and gates on the subscription
	 *  (the gate pushes checkout:required back to the panel). */
	'host.pipeline.run': ShellOpSpec<{ doc: string; source?: string; action: 'run' | 'restart' }, void>;
	/** Stops the document's running source. */
	'host.pipeline.stop': ShellOpSpec<{ doc: string; source: string }, void>;
	/** Saves the document — same flow as the Ctrl+S keybinding. */
	'host.pipeline.save': ShellOpSpec<{ doc: string }, void>;
	/** ROCKETRIDE_* refs the canvas found that are not in the env — the host
	 *  offers the add-variables flow. */
	'host.pipeline.missingEnv': ShellOpSpec<{ keys: string[] }, void>;
	/** Opens a URL: system browser (`browser`, scheme-allowlisted) or the
	 *  bridged iframe panel (clipboard/file-dialog/drag bridging). */
	'host.pipeline.openLink': ShellOpSpec<{ url: string; displayName?: string; browser?: boolean }, void>;
}
