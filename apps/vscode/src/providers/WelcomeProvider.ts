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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Welcome Page Provider — a FRAMEWORK PAGE (see shared/frameworkPage).
 *
 * Shows a branded welcome/setup page on first install. Delays engine download
 * and connection until the user explicitly configures and confirms their setup.
 *
 * The page auto-opens until the user unchecks "Show welcome page on startup".
 * The user setting 'rocketride.welcomeDismissed' persists this preference.
 *
 * Connection-related messages (cloud auth, docker/service lifecycle, engine
 * versions, test connection) are delegated to the shared ConnectionMessageHandler.
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { ConfigManager } from '../config';
import { getConnectionManager, getEngineRegistry } from '../extension';
import { commitStagedCloudCredentials } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConnectionMessageHandler } from './shared/connection-message-handler';
import { FrameworkPageProvider } from './shared/frameworkPage';

const DISMISSED_KEY = 'welcomeDismissed';

export class WelcomeProvider extends FrameworkPageProvider {
	private configManager: ConfigManager;
	private connHandler: ConnectionMessageHandler;
	/** True while the provider itself is being disposed (host shutdown) — a
	 * panel closed by shutdown is NOT a user dismissal. */
	private isShuttingDown = false;
	private cleanupCloudAuth: (() => void) | null = null;

	constructor(context: vscode.ExtensionContext, extensionUri: vscode.Uri) {
		super(context, extensionUri, {
			command: 'rocketride.page.welcome.open',
			viewType: 'rocketride.page.welcome',
			title: 'Welcome to RocketRide',
			entry: 'page-welcome',
			retain: true,
		});
		this.configManager = ConfigManager.getInstance();
		this.connHandler = new ConnectionMessageHandler({
			extensionFsPath: extensionUri.fsPath,
			getActiveWebviews: () => (this.panel ? [this.panel.webview] : []),
			getConnectionManager,
			getEngineRegistry,
		});
	}

	/** Whether the user has already dismissed the welcome page */
	public isDismissed(): boolean {
		return vscode.workspace.getConfiguration('rocketride').get<boolean>(DISMISSED_KEY, false);
	}

	protected override onPanelCreated(): void {
		this.cleanupCloudAuth = this.connHandler.registerCloudAuthListener(this.panel!.webview);
	}

	protected override onPanelDisposed(): void {
		this.cleanupCloudAuth?.();
		this.cleanupCloudAuth = null;
		// Closing without Save & Connect discards any staged sign-in/out.
		// (After a successful save the staged state is already committed,
		// so this is a no-op on the normal path.)
		CloudAuthProvider.getInstance().clearPendingChanges();
		// Closing the welcome page — by ANY user exit (the tab's X,
		// Advanced Settings, Save & Connect) — counts as dismissal, so it
		// never nags again on the next activation. Host shutdown is not a
		// user exit. Best-effort: a write failure must not throw here.
		if (!this.isShuttingDown) {
			vscode.workspace
				.getConfiguration('rocketride')
				.update(DISMISSED_KEY, true, vscode.ConfigurationTarget.Global)
				.then(undefined, () => { /* best effort */ });
		}
		this.connHandler.stopStatusPolling();
	}

	protected override async handleMessage(message: { type: string } & Record<string, unknown>): Promise<void> {
		try {
			switch (message.type) {
				case 'view:ready':
					await this.sendCurrentSettings();
					// Server probe is triggered by CloudPanel when cloud mode is selected
					await this.connHandler.startStatusPolling();
					break;

				case 'settings:saveAndConnect':
					await this.saveAndConnect(message.settings as Record<string, unknown>);
					break;

				case 'settings:open':
					this.panel?.dispose();
					vscode.commands.executeCommand('rocketride.page.settings.open');
					break;

				case 'settings:openExternal':
					if (message.url) {
						vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
					}
					break;

				default: {
					// Delegate connection messages (cloud, docker, service, test, engine versions, sudo)
					const handled = this.panel ? await this.connHandler.handleMessage(message, this.panel.webview) : false;
					if (handled) break;

					getLogger().info(`[WelcomeProvider] Unhandled message type: ${String(message.type)}`);
					break;
				}
			}
		} catch (error) {
			getLogger().error(`[WelcomeProvider] Message handling error: ${String(error)}`);
			const msgType = message.type;
			if (msgType.startsWith('docker')) {
				this.post({ type: 'docker:error', message: `${error}` });
			} else if (msgType.startsWith('service')) {
				this.post({ type: 'service:error', message: `${error}` });
			} else {
				this.post({ type: 'settings:showMessage', level: 'error', message: `Error: ${error}` });
			}
		}
	}

	/** Send current config to the webview so the form is pre-populated */
	private async sendCurrentSettings(): Promise<void> {
		if (!this.panel) return;

		const config = this.configManager.getConfig();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');

		let apiKey = '';
		if (this.configManager.hasApiKey()) {
			try {
				apiKey = config.development.apiKey || '';
			} catch {
				/* ignore */
			}
		}

		const logoDarkUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-dark-icon.png'));
		const logoLightUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'rocketride-light-icon.png'));

		// The cloudUrl settings' package.json defaults — CloudPanel probes the
		// effective target and can't render its sign-in UI without them.
		const devDefaultCloudUrl = vscode.workspace.getConfiguration('rocketride.development').inspect<string>('cloudUrl')?.defaultValue ?? '';
		const depDefaultCloudUrl = vscode.workspace.getConfiguration('rocketride.deployment').inspect<string>('cloudUrl')?.defaultValue ?? '';

		// Send nested structure matching the webview SettingsData type. Every
		// SettingsData field must be present: the webview replaces its whole
		// settings object with this payload and sends it back verbatim on
		// Save & Connect — a missing field would be written as `undefined`,
		// silently resetting that setting to its default.
		this.post({
			type: 'settings:loaded',
			logoDarkUri: logoDarkUri.toString(),
			logoLightUri: logoLightUri.toString(),
			settings: {
				development: {
					connectionMode: config.development.connectionMode,
					hostUrl: config.development.hostUrl,
					useCustomServer: config.development.useCustomServer,
					cloudUrl: config.development.cloudUrl,
					defaultCloudUrl: devDefaultCloudUrl,
					apiKey,
					hasApiKey: this.configManager.hasApiKey(),
					local: {
						engineVersion: config.development.local.engineVersion,
					},
				},
				deployment: {
					connectionMode: config.deployment.connectionMode,
					hostUrl: config.deployment.hostUrl,
					useCustomServer: config.deployment.useCustomServer,
					cloudUrl: config.deployment.cloudUrl,
					defaultCloudUrl: depDefaultCloudUrl,
					hasApiKey: !!config.deployment.apiKey,
					apiKey: config.deployment.apiKey || '',
					local: {
						engineVersion: config.deployment.local.engineVersion,
					},
				},
				defaultPipelinePath: config.defaultPipelinePath,
				pipelineRestartBehavior: config.pipelineRestartBehavior,
				pipelineTtl: config.pipelineTtl,
				pipelineTraceLevel: config.pipelineTraceLevel,
				taskArguments: config.taskArguments,
				pipelineDebugOutput: config.pipelineDebugOutput,
				autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
				integrationCopilot: workspaceConfig.get('integrations.copilot', false),
				integrationClaudeCode: workspaceConfig.get('integrations.claudeCode', false),
				integrationCursor: workspaceConfig.get('integrations.cursor', false),
				integrationWindsurf: workspaceConfig.get('integrations.windsurf', false),
				integrationClaudeMd: workspaceConfig.get('integrations.claudeMd', false),
				integrationAgentsMd: workspaceConfig.get('integrations.agentsMd', false),
			},
		});
	}

	/**
	 * Persist the user's welcome-page settings and kick off the first connection.
	 *
	 * Sequence mirrors SettingsProvider.saveAllSettings():
	 *   1. Atomic config write (listeners suppressed)
	 *   2. Mark welcome as dismissed so it won't re-open
	 *   3. Cancel stale debounced handlers that would race with reconcile
	 *   4. Initialize CMs (validates creds, sets mode)
	 *   5. Reconcile engines (downloads/starts, CMs auto-connect on 'ready')
	 *   6. Close the welcome panel
	 *
	 * @param settings - The full settings snapshot from the welcome form.
	 */
	private async saveAndConnect(settings: Record<string, unknown>): Promise<void> {
		try {
			// Step 1: Atomic write — suppresses config-change listeners during the batch
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await this.configManager.applyAllSettings(settings as any);

			// Step 1b: Commit any staged cloud sign-in/sign-out together with the
			// form it belongs to (the welcome flow is transactional like Settings).
			await commitStagedCloudCredentials();

			// Step 2: Persist dismissal so the welcome page doesn't re-open on next activation
			await vscode.workspace.getConfiguration('rocketride').update(DISMISSED_KEY, true, vscode.ConfigurationTarget.Global);

			// Step 3: The welcomeDismissed write above fires a config-change event
			// AFTER the batch flag is cleared. Cancel it so it doesn't race with
			// the reconcile we're about to trigger.
			const connectionManager = getConnectionManager();
			connectionManager?.cancelPendingConfigChange();

			// Step 4-5: Initialize CMs then reconcile — same order as normal activation
			if (connectionManager) await connectionManager.initialize();

			const registry = getEngineRegistry();
			if (registry) await registry.reconcile();

			// Step 6: Close panel — engines are starting, CMs will auto-connect
			this.panel?.dispose();
		} catch (error) {
			getLogger().error(`[WelcomeProvider] Failed to save settings: ${String(error)}`);
			this.post({ type: 'settings:showMessage', level: 'error', message: `Failed to save settings: ${error}` });
		}
	}

	public override dispose(): void {
		this.isShuttingDown = true;
		this.connHandler.dispose();
		super.dispose();
	}
}
