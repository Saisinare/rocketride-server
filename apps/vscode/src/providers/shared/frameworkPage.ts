// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * FrameworkPageProvider — the ONE webview-panel base for framework pages.
 *
 * Framework pages are the surfaces that exist with zero tools installed
 * (welcome, settings, account, environment/variables): interactive React
 * webviews owned by the host chrome, not by any dev tool. Every one of
 * them needs the same plumbing — an open command, a create-or-reveal
 * panel, the bundled-page HTML with CSP/nonce/resource rewriting, message
 * wiring, disposal — which previously existed as per-provider copies.
 * Subclasses contribute ONLY their page spec and message handling.
 */

import * as vscode from 'vscode';
import { getLogger } from '../../shared/util/output';

/** One framework page's identity and wiring. */
export interface FrameworkPageSpec {
	/** The open command ('rocketride.page.<key>.open'). */
	command: string;
	/** Panel viewType (stable — tab restore identity). */
	viewType: string;
	/** Panel title. */
	title: string;
	/** The built webview page name ('page-welcome' → webview/page-welcome.html). */
	entry: string;
	/** Keep the webview alive while hidden (stateful pages). */
	retain?: boolean;
}

export abstract class FrameworkPageProvider {
	protected panel: vscode.WebviewPanel | undefined;
	protected disposables: vscode.Disposable[] = [];

	constructor(
		protected readonly context: vscode.ExtensionContext,
		protected readonly extensionUri: vscode.Uri,
		protected readonly spec: FrameworkPageSpec,
	) {
		const cmd = vscode.commands.registerCommand(spec.command, (...args: unknown[]) => {
			void this.show(...args);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// ── Lifecycle hooks (subclass surface) ───────────────────────────────────

	/** Handles one webview message (including 'view:ready'). */
	protected abstract handleMessage(message: { type: string } & Record<string, unknown>): void | Promise<void>;

	/** Called after the panel is created (before any message). The command's
	 *  arguments are forwarded — pages with open-parameters stash them here. */
	protected onPanelCreated(..._args: unknown[]): void | Promise<void> {}

	/** Called when the user (or shutdown) closes the panel. */
	protected onPanelDisposed(): void {}

	// ── Panel lifecycle ──────────────────────────────────────────────────────

	/**
	 * Creates or reveals the page's panel; command arguments forward to
	 * {@link onPanelCreated} (and to re-reveals via {@link onPanelRevealed}).
	 */
	public async show(...args: unknown[]): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			await this.onPanelRevealed(...args);
			return;
		}
		this.panel = vscode.window.createWebviewPanel(this.spec.viewType, this.spec.title, vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
			...(this.spec.retain ? { retainContextWhenHidden: true } : {}),
		});
		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
		const messages = this.panel.webview.onDidReceiveMessage(async (message) => {
			if (!this.panel) return;
			try {
				await this.handleMessage(message);
			} catch (error) {
				getLogger().error(`[${this.spec.entry}] message failed: ${String(error)}`);
			}
		});
		this.panel.onDidDispose(() => {
			messages.dispose();
			this.panel = undefined;
			this.onPanelDisposed();
		});
		await this.onPanelCreated(...args);
	}

	/** Re-reveal hook — pages with open-parameters re-apply them here. */
	protected async onPanelRevealed(..._args: unknown[]): Promise<void> {}

	/** Posts one message into the page (no-op without a live panel). */
	protected post(message: unknown): void {
		void this.panel?.webview.postMessage(message);
	}

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		this.panel?.dispose();
		this.panel = undefined;
	}

	// ── HTML (the one copy of the 23 we had) ─────────────────────────────────

	/** Loads the built page HTML, stamping nonce/CSP and rewriting static
	 *  resource paths to webview URIs. */
	protected getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', `${this.spec.entry}.html`);
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			let htmlContent: string = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			getLogger().error(`Error loading ${this.spec.entry} HTML: ${String(error)}`);
			return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error</title></head><body>
				<div style="padding: 20px; color: #f44336;">
					<h3>Error Loading ${this.spec.title}</h3>
					<p><strong>Error:</strong> ${String(error)}</p>
					<p>Run <code>pnpm run build</code> to build the webview.</p>
					<p>Expected: <code>${htmlPath.fsPath}</code></p>
				</div></body></html>`;
		}
	}
}

/** A 32-char alphanumeric CSP nonce. */
function generateNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
	return text;
}
