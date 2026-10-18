// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dev Tool Details (README) Provider
 *
 * The modules flow's detail page — VS Code extension-page style: a row in
 * the sidebar's Dev Tools list opens a panel showing the tool's identity
 * header (icon, name, publisher, version), Install/Remove actions, and the
 * app's README markdown.
 *
 * The page is a BUS REALM served by the shared page-frame bundle: catalog
 * facts come off the mirror (accountInfo.apps), Install/Remove ride the
 * `host.devtools.*` ops, and the tool's identity is stamped into the served
 * HTML (`data-rr-args`). This provider's whole job is per-tool panel
 * ownership — unlike FrameworkProvider's singletons, details pages open one
 * panel PER TOOL.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import type { BusHost } from './toolhost/busHost';
import { renderPageFrameHtml } from './toolhost/frameworkProvider';

// =============================================================================
// PROVIDER
// =============================================================================

export class DevToolReadmeProvider {
	/** Open detail panels, one per tool app id. */
	private panels = new Map<string, vscode.WebviewPanel>();

	/** Subscriptions and listeners to clean up on dispose. */
	private disposables: vscode.Disposable[] = [];

	/**
	 * Creates the provider and registers the details command.
	 *
	 * @param context - The VS Code extension context for subscriptions and URIs.
	 * @param busHost - The shell bus router each details panel attaches to.
	 */
	constructor(private context: vscode.ExtensionContext, private busHost: BusHost) {
		const cmd = vscode.commands.registerCommand('rocketride.devtool.readme', (appId?: string) => {
			if (typeof appId === 'string' && appId) this.show(appId);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/**
	 * Opens (or reveals) the details panel for one tool.
	 *
	 * @param appId - The tool's app id.
	 */
	public show(appId: string): void {
		const existing = this.panels.get(appId);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		// Title from the current catalog (best effort — the page itself stays
		// correct off the mirror either way).
		const apps = (ConnectionManager.getInstance().getClient()?.getAccountInfo()?.apps ?? []) as Array<{ id: string; name?: string }>;
		const name = apps.find((a) => a?.id === appId)?.name ?? appId;

		const panel = vscode.window.createWebviewPanel('rocketride.page.devToolReadme', `Dev Tool: ${name}`, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		this.panels.set(appId, panel);

		try {
			panel.webview.html = renderPageFrameHtml(this.context, panel.webview, 'devtool-readme', { appId });
		} catch (error) {
			panel.webview.html = `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Dev Tool Page</h3>
                <pre>${error}</pre>
            </body></html>`;
		}

		const detachRealm = this.busHost.attachWebview(panel.webview, `page:devtool-readme:${appId}`);
		panel.onDidDispose(() => {
			detachRealm();
			this.panels.delete(appId);
		});
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Disposes all subscriptions and closes every open panel. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const panel of this.panels.values()) panel.dispose();
		this.panels.clear();
	}
}
