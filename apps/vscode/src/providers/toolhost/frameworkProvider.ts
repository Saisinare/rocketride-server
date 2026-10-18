// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FRAMEWORK PROVIDER — a generic webview-panel host for bus-realm framework pages
// =============================================================================
//
// A framework page (Account, Environment, ...) renders SHELL components in a
// webview and reaches the engine ONLY over the shell bus (request('client.*')
// against the BusHost broker). The extension host's entire job for such a
// page is: register the open command, own the singleton panel, serve the
// built HTML, and attach the webview as a bus realm. No page-specific
// message protocol exists — one FrameworkProvider instance replaces what used to be
// a 400–1300 line relay provider per page.
// =============================================================================

import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import * as crypto from 'crypto';
import type { BusHost } from './busHost';

/** The one HTML bundle every framework page shares (see views/page-frame). */
const FRAME_HTML = 'page-frame.html';

/** One framework page's wiring. */
export interface IFrameworkProviderOptions {
	/** The page's registry name — stamped into the served HTML and resolved
	 *  by the page-frame bundle's compiled-in component registry. Also the
	 *  name `host.openPage` routes by. */
	page: string;
	/** The open command id (e.g. 'rocketride.page.account.open'). */
	command: string;
	/** The panel viewType (e.g. 'rocketride.page.account'). */
	viewType: string;
	/** The panel tab title. */
	title: string;
	/** Optional hook fired on every command invocation (open AND reveal)
	 *  with the command's arguments — e.g. the Environment page's
	 *  missing-keys prefill. */
	onOpen?: (args: unknown[]) => void;
}

/**
 * Hosts one framework page: command → singleton panel → bus realm. All
 * pages serve the SAME page-frame bundle; only the stamped name differs.
 */
export class FrameworkProvider {
	/** page name → open — the `host.openPage` directory (self-registered). */
	private static readonly directory = new Map<string, (args: unknown[]) => void>();

	/** Opens a page by registry name. @returns False for an unknown page. */
	public static openPage(page: string, args: unknown[] = []): boolean {
		const open = FrameworkProvider.directory.get(page);
		if (!open) return false;
		open(args);
		return true;
	}

	private panel: vscode.WebviewPanel | null = null;
	private detachRealm: (() => void) | null = null;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly busHost: BusHost,
		private readonly options: IFrameworkProviderOptions
	) {
		const open = (args: unknown[]): void => {
			options.onOpen?.(args);
			this.show();
		};
		const cmd = vscode.commands.registerCommand(options.command, (...args: unknown[]) => open(args));
		FrameworkProvider.directory.set(options.page, open);
		this.disposables.push(cmd, { dispose: () => FrameworkProvider.directory.delete(options.page) });
		context.subscriptions.push(cmd);
	}

	/** Opens (or reveals) the page's webview panel. */
	public show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(this.options.viewType, this.options.title, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		this.panel = panel;
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// The page is a bus realm — ALL its traffic rides the `__rrbus`
		// envelope; there is no page-specific postMessage protocol.
		this.detachRealm = this.busHost.attachWebview(panel.webview, `page:${this.options.page}`);

		panel.onDidDispose(() => {
			this.detachRealm?.();
			this.detachRealm = null;
			this.panel = null;
		});
	}

	/**
	 * Reads the shared page-frame HTML and injects nonce + webview URIs +
	 * THE PAGE NAME (a body data attribute — present before any script runs,
	 * so the bundle mounts the right component with no handshake).
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(32).toString('base64url');
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', FRAME_HTML);

		try {
			let htmlContent = readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);
			htmlContent = htmlContent.replace('<body', `<body data-rr-page="${this.options.page}"`);
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading ${this.options.title} Page</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
		}
	}

	/** Disposes the command registration and closes the panel if open. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		this.panel?.dispose();
		this.panel = null;
	}
}
