// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV TOOL OPS — the pinned-tools store over the bus
// =============================================================================
//
// `host.devtools.*` (declared in shared/ops/hostOps.ts): the Install/Remove
// surface the dev-tool details pages drive. The pinned set is HOST state
// (DevToolStore persists it per workspace); every change pushes
// `host.devtools.changed` so all open surfaces (details pages, the sidebar
// strip) agree without asking.
// =============================================================================

import type * as vscode from 'vscode';
// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { HostOpMap } from 'shared/ops/hostOps';
import type { DevToolStore } from '../providers/DevToolStore';

/** What the registrations need from the host. */
export interface IDevToolOpsDeps {
	context: vscode.ExtensionContext;
	/** The pinned-tools store Install/Remove acts on. */
	devTools: DevToolStore;
	/** Closes a tool's open frame panel (the Remove flow retires it). */
	closeToolPanel: (appId: string) => void;
	/** Fire-and-forget op to every attached realm (BusHost.broadcastEmitOp). */
	broadcast: (op: string, params: unknown) => void;
}

/**
 * Registers the pinned-tools ops and the change push (disposed via
 * context.subscriptions).
 */
export function registerVscodeDevToolOps(bus: IOpBus, deps: IDevToolOpsDeps): void {
	const { context, devTools, closeToolPanel, broadcast } = deps;

	const impls: OpImplTable<HostOpMap> = {
		'host.devtools.installed': () => ({ ids: devTools.getAll() }),
		// Pin — the store change fans out (tab strip, details pages) through
		// the changed push below.
		'host.devtools.install': (p) => {
			devTools.add(p.appId);
		},
		// Unpin AND retire the tool's open frame panel; a details page stays
		// open (VS Code keeps the extension page open after uninstall too).
		'host.devtools.remove': (p) => {
			devTools.remove(p.appId);
			closeToolPanel(p.appId);
		},
	};
	registerOpHandlers<HostOpMap>(bus, impls);

	context.subscriptions.push(devTools.onDidChange(() => broadcast('host.devtools.changed', { ids: devTools.getAll() })));
}
