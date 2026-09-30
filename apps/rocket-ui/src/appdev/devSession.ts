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
// WEB DEV SESSION — the design loop: models -> emit -> link -> inject
// =============================================================================

/**
 * One app document's design loop. Owns:
 *
 *  - The VFS: a CachedVfs over the app folder — the tree inventory (ALL
 *    files, binary assets included), the content cache, and the dirty
 *    aggregate the Code pane's Explorer renders. Models register as
 *    overlays, so `vfs.read()` always serves the CURRENT truth (the buffer
 *    while dirty, the cache/store otherwise).
 *  - The MODEL STORE: every working-tree TEXT file as a Monaco model
 *    (per-app URI namespace file:///<appId>/...), loaded in one fsReadMany
 *    sweep; dirty tracking; saves through the VFS back to the store.
 *  - The TS setup: compiler options + bundled React types + the fetched
 *    platform types (shell.d.ts, vendored SDK) + automatic type acquisition
 *    (ata.ts) for everything the source imports.
 *  - The BUILD: per-changed-file TS-worker emit (content-cached) ->
 *    Fast-Refresh instrumentation -> blob-link -> registerLocalApp into
 *    the preview realm. Remount is the baseline; a component-only save
 *    takes the hot path (single re-import + performReactRefresh) so state
 *    survives.
 *  - The FEEDS: console/errors (preview forwarding + build output) and
 *    watch status ('building' / 'ok' / 'error'+reason) with replayed
 *    backlogs, mirroring the VSCode host's feed contract.
 *  - DEPENDENCIES: package.json deps resolved through the lock map +
 *    fetch-and-rewrite loader; undeclared imports surface as Monaco
 *    markers with an add-to-dependencies quick fix.
 */

import * as LocalJsxRuntime from 'react/jsx-runtime';
import * as LocalJsxDevRuntime from 'react/jsx-dev-runtime';
import * as LocalRocketride from 'rocketride';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { ConnectionManager, CachedVfs } from 'shell';
import type { RocketRideClient, ShellNotification } from 'shell';
import type { AppCodeStore, ConsoleRow, AppErrorRow, WatchStatus } from 'shared/modules/appdev';
import { loadMonaco, setupAppTypescript, emitModel, detectLanguage } from 'shared/modules/monaco';
import type { Monaco, TypescriptSetupHandle } from 'shared/modules/monaco';
import { createAppVfsBackend, isTextFile, loadAppFiles, SKIP_DIRS } from './appFiles';
import { appPath, readAppPackage } from './appStore';
import { fetchPlatformTypeLibs } from './typesFeed';
import { linkModules, revokeLink, ensureLexer } from './linker';
import type { LinkModule, LinkResult } from './linker';
import { prepareDependencies } from './deps';
import type { DependencySet } from './deps';
import { createAtaEngine } from './ata';
import type { AtaEngine } from './ata';
import { loadRefreshTools, isComponentOnlyModule } from './hmr';
import type { RefreshTools } from './hmr';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Per-feed backlog cap (matches the VSCode host's FEED_BACKLOG). */
const FEED_BACKLOG = 500;

/** The linked entry module — the MF expose root's source. */
const ENTRY_PATH = 'src/AppDescriptor.ts';

/** Marker owner for the session's diagnostics. */
const MARKER_OWNER = 'rr-appdev';

/** Renders a feed timestamp ("09:12:11"). */
function feedTime(): string {
	return new Date().toTimeString().slice(0, 8);
}

/**
 * Page-shared Monaco emit cache — key `<model URI>@<versionId>` value the
 * TS-worker output.
 *
 * The emit (TS -> JS) is a pure function of a model's content, and split
 * panels share one Monaco model per URI, so two sessions of the same app
 * transpile each file ONCE between them instead of each running its own
 * worker pass. Only this stage is shared: instrumentation bakes in the
 * session namespace and linking binds to a preview realm's share scope, so
 * both stay per-session/per-realm downstream.
 *
 * Bounded by the number of distinct files opened this page-session (one
 * entry per URI+version; a new version overwrites via the versioned key,
 * and superseded entries are pruned in emitOne). The whole map dies with
 * the page.
 */
const sharedEmitCache = new Map<string, { js: string; map?: string }>();

/** The shared-cache key for one model at one version. */
function emitKey(uri: string, version: number): string {
	return `${uri}@${version}`;
}

// =============================================================================
// SESSION
// =============================================================================

/**
 * The web App Builder dev session (see the module doc).
 */
export class WebDevSession {
	private readonly client: RocketRideClient;
	private readonly appId: string;
	private readonly folder: string;
	private readonly appName: string;
	private readonly moduleId: string;

	private monaco: Monaco | null = null;
	private tsHandle: TypescriptSetupHandle | null = null;
	/** Automatic type acquisition — downloads .d.ts for whatever the source imports. */
	private ata: AtaEngine | null = null;
	private disposed = false;

	/** This session's identity on the notification bus (echo suppression). */
	private readonly sessionId = crypto.randomUUID();
	/** Unsubscribes the shell:notify listener; null until open(). */
	private unsubscribeNotify: (() => void) | null = null;

	// ── Models + dirty state ─────────────────────────────────────────────
	private readonly models = new Map<string, MonacoEditorNs.ITextModel>();
	private readonly dirty = new Set<string>();
	private readonly storeListeners = new Set<() => void>();
	/** Unregister functions for the models' VFS overlays. */
	private readonly overlayDisposers: Array<() => void> = [];
	/** Why open() failed ('' = it did not) — the Code pane renders this. */
	private openError = '';

	// ── Build state ──────────────────────────────────────────────────────
	private lastLink: LinkResult | null = null;
	private deps: DependencySet | null = null;
	private building = false;
	private buildQueued = false;
	private mounted = false;

	// ── Preview target ───────────────────────────────────────────────────
	private previewWindow: Window | null = null;
	private refresh: RefreshTools | null = null;

	// ── Feeds ────────────────────────────────────────────────────────────
	private readonly consoleBuffer: ConsoleRow[] = [];
	private readonly consoleListeners = new Set<(row: ConsoleRow) => void>();
	private readonly errorBuffer: AppErrorRow[] = [];
	private readonly errorListeners = new Set<(row: AppErrorRow) => void>();
	private watchStatus: WatchStatus = { state: 'idle' };
	private readonly watchListeners = new Set<(status: WatchStatus) => void>();

	/** The Code pane's view of this session. */
	public readonly store: AppCodeStore;

	/**
	 * The working tree as a caching VFS: the FULL inventory (binary assets
	 * included), content cache, and the models' dirty overlays. The Code
	 * pane's Explorer and preview panes read through this seam.
	 */
	public readonly vfs: CachedVfs;

	/**
	 * @param client - The connected RocketRide client.
	 * @param appId - The app id.
	 * @param folder - The .appdev folder name.
	 * @param appName - Display name (registerLocalApp meta).
	 */
	constructor(client: RocketRideClient, appId: string, folder: string, appName: string) {
		this.client = client;
		this.appId = appId;
		this.folder = folder;
		this.appName = appName;
		this.moduleId = appId.replace(/[^a-zA-Z0-9_$]/g, '_');
		this.vfs = new CachedVfs(createAppVfsBackend(client, folder, this.sessionId), { skipDirs: SKIP_DIRS });
		this.store = {
			listFiles: () => [...this.models.keys()].sort(),
			getModel: (path) => this.models.get(path) ?? null,
			isDirty: (path) => this.dirty.has(path),
			save: (path) => this.saveFile(path),
			getLoadError: () => this.openError || null,
			subscribe: (listener) => {
				this.storeListeners.add(listener);
				return () => this.storeListeners.delete(listener);
			},
		};
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	/**
	 * Opens the session: loads Monaco + the working tree into models and
	 * registers the type feeds. Injection waits for attachPreview().
	 *
	 * Every failure is SURFACED (openError -> Code pane, watch 'error',
	 * errors feed) — a swallowed rejection here reads as an eternal
	 * "Loading files" and cost a debugging session; never again.
	 */
	async open(): Promise<void> {
		try {
			console.log('[appdev] session open: loading editor...');
			const monaco = await loadMonaco();
			if (this.disposed) return;
			this.monaco = monaco;
			this.tsHandle = setupAppTypescript(monaco);
			this.ata = createAtaEngine(this.tsHandle, (message) => this.pushConsole('warn', message));
			await ensureLexer();

			// step: platform types (server-versioned) — fetched, IndexedDB-cached
			void fetchPlatformTypeLibs()
				.then((libs) => {
					if (this.disposed || !this.tsHandle) return;
					for (const lib of libs) this.tsHandle.addExtraLib(lib.content, lib.path);
					console.log(`[appdev] platform types registered (${libs.length} libs)`);
				})
				.catch((err) => {
					this.pushConsole('warn', `[types] platform types unavailable: ${err instanceof Error ? err.message : String(err)}`);
				});

			// step: inventory the whole tree (ALL files — binaries included),
			// then bulk-load just the TEXT files into models
			console.log('[appdev] session open: listing working tree...');
			await this.vfs.refresh();
			const paths = this.vfs.listEntries()
				.filter((e) => e.type === 'file' && isTextFile(e.path))
				.map((e) => e.path);
			console.log(`[appdev] session open: loading ${paths.length} files...`);
			const files = await loadAppFiles(this.client, this.folder, paths);
			if (this.disposed) return;
			for (const [path, text] of files) {
				this.vfs.prime(path, text);
				this.wireModel(path, text);
			}
			console.log(`[appdev] session open: ${this.models.size} models ready`);
			this.notifyStore();
			this.setWatch({ state: 'idle' });

			// step: join the notification bus AFTER the tree is loaded — an
			// onFsChange landing mid-load would race the model sweep above
			this.unsubscribeNotify = ConnectionManager.getInstance().on('shell:notify', (n: ShellNotification) => {
				if (n.kind === 'onFsChange') this.onFsChange(n.uri, n.origin);
			});
		} catch (err) {
			const reason = err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error('[appdev] session open FAILED:', reason);
			this.openError = err instanceof Error ? err.message : String(err);
			this.pushError(`[open] ${this.openError}`);
			this.setWatch({ state: 'error', reason: this.openError });
			this.notifyStore();
		}
	}

	/**
	 * Adopts a preview realm (the iframe, or the debug tab) as the injection
	 * target: attaches the refresh runtime and runs the first build.
	 *
	 * @param win - The same-origin preview window.
	 */
	async attachPreview(win: Window): Promise<void> {
		this.previewWindow = win;
		this.mounted = false;
		// step: dev-API version gate — the share scope must carry the jsx
		// runtimes (v2); an older shell can only run the remount loop
		const api = (win as unknown as { __rrShellDev?: { version: number } }).__rrShellDev;
		if (!api) {
			this.setWatch({ state: 'error', reason: 'The preview shell exposes no dev hooks — is it a dev-flavor shell with rrdev=1?' });
			return;
		}
		// step: attach Fast Refresh (lazy toolchain; degrade to remounts on failure)
		try {
			this.refresh = await loadRefreshTools();
			this.refresh.attach(win);
		} catch (err) {
			this.refresh = null;
			this.pushConsole('warn', `[hmr] Fast Refresh unavailable — falling back to remounts: ${err instanceof Error ? err.message : String(err)}`);
		}
		await this.rebuild();
	}

	/**
	 * Routes a preview postMessage (console/error forwarding) into the feeds.
	 *
	 * @param data - The posted message.
	 */
	handlePreviewMessage(data: Record<string, unknown> | undefined): void {
		if (!data || typeof data.type !== 'string') return;
		if (data.type === 'shell:devConsole') {
			const level = data.level === 'warn' || data.level === 'error' ? data.level : 'log';
			this.pushConsole(level, String(data.text ?? ''));
		} else if (data.type === 'shell:devError') {
			this.pushError(String(data.message ?? ''), typeof data.source === 'string' ? data.source : undefined);
		}
	}

	/** Tears the session down (models, overlays, blobs, type libs, feeds). */
	dispose(): void {
		this.disposed = true;
		this.unsubscribeNotify?.();
		this.unsubscribeNotify = null;
		if (this.lastLink) revokeLink(this.lastLink.blobUrls);
		this.ata?.dispose();
		this.ata = null;
		for (const disposeOverlay of this.overlayDisposers) disposeOverlay();
		this.overlayDisposers.length = 0;
		for (const model of this.models.values()) model.dispose();
		this.models.clear();
		this.tsHandle?.dispose();
		this.consoleListeners.clear();
		this.errorListeners.clear();
		this.watchListeners.clear();
		this.storeListeners.clear();
	}

	// =========================================================================
	// MODEL WIRING
	// =========================================================================

	/**
	 * Creates (or adopts) the Monaco model for one text file and registers
	 * it as the file's VFS overlay: while the model is dirty, `vfs.read()`
	 * serves the buffer — every consumer sees the current truth through the
	 * one seam.
	 *
	 * @param path - The project-relative file path.
	 * @param text - The file's loaded content.
	 * @returns The wired model.
	 */
	private wireModel(path: string, text: string): MonacoEditorNs.ITextModel {
		const monaco = this.monaco!;
		const uri = monaco.Uri.parse(`file:///${this.appId}/${path}`);
		const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, detectLanguage(path), uri);
		this.models.set(path, model);
		const isSource = /\.(ts|tsx)$/.test(path);
		if (isSource) this.ata?.enqueue(path, () => model.getValue());
		model.onDidChangeContent(() => {
			// step: acquisition follows the keystrokes (debounced in the engine)
			if (isSource) this.ata?.enqueue(path, () => model.getValue());
			if (!this.dirty.has(path)) {
				this.dirty.add(path);
				this.notifyStore();
			}
		});
		this.overlayDisposers.push(this.vfs.registerOverlay(path, {
			getContent: () => model.getValue(),
			isDirty: () => this.dirty.has(path),
		}));
		return model;
	}

	// =========================================================================
	// SAVE -> BUILD
	// =========================================================================

	/**
	 * Persists one file and re-renders: the hot path (component-only .tsx
	 * save with refresh attached) re-imports just that module; everything
	 * else re-links and remounts.
	 *
	 * @param path - The project-relative file path.
	 */
	async saveFile(path: string): Promise<void> {
		const model = this.models.get(path);
		if (!model) return;
		// step: through the VFS — persists, updates the content cache, and
		// announces the write (origin-stamped) on the notification bus
		await this.vfs.write(path, model.getValue());
		this.dirty.delete(path);
		this.notifyStore();

		// step: a package.json save re-settles dependencies
		if (path === 'package.json') {
			this.deps = null;
		}

		// step: hot path — component-only module with an attached refresh
		if (this.mounted && this.refresh && path.endsWith('.tsx') && path !== ENTRY_PATH && this.lastLink) {
			const emitted = await this.emitOne(path);
			if (emitted && (await isComponentOnlyModule(emitted.js))) {
				const ok = await this.hotSwap(path, emitted);
				if (ok) return;
			}
		}
		await this.rebuild();
	}

	// =========================================================================
	// FOREIGN CHANGES — the notification bus (another session, Store pane, …)
	// =========================================================================

	/**
	 * Routes one onFsChange notification: only foreign writes inside THIS
	 * app's folder matter — the session's own saves already built.
	 *
	 * @param uri - The full store path that changed.
	 * @param origin - The writer's identity.
	 */
	private onFsChange(uri: string, origin: string): void {
		if (this.disposed || origin === this.sessionId) return;
		const prefix = `${appPath(this.folder)}/`;
		if (!uri.startsWith(prefix)) return;
		void this.adoptExternalChange(uri.slice(prefix.length));
	}

	/**
	 * Adopts a foreign write: refreshes the file's model from the store
	 * (CLEAN models only — a dirty model is the user's unsaved work and is
	 * never clobbered; split panels share Monaco models, so the common case
	 * is "content already current"), then re-renders an attached preview.
	 *
	 * @param path - The project-relative path that changed.
	 */
	private async adoptExternalChange(path: string): Promise<void> {
		if (!this.monaco) return;

		// step: a package.json change re-settles dependencies wherever it
		// came from (Store pane listing save, another session, scaffold)
		if (path === 'package.json') {
			this.deps = null;
		}

		// step: a foreign BINARY change never becomes a model — record the
		// entry (new assets appear in the tree) and drop stale cached bytes
		if (!isTextFile(path)) {
			this.vfs.invalidate(path);
			this.vfs.upsert(path, 'file');
			return;
		}

		try {
			const text = await this.client.fsReadString(appPath(this.folder, path));
			if (this.disposed) return;
			this.vfs.prime(path, text);
			const model = this.models.get(path);
			if (!model) {
				// step: a NEW file — wire it exactly like open() does
				this.wireModel(path, text);
				this.notifyStore();
			} else if (model.getValue() === text) {
				// step: model already matches the store. Split panels share
				// Monaco models, so the writer's keystrokes marked THIS
				// session's dirty flag too — the store now agrees, so nothing
				// here is unsaved: clear the mark.
				if (this.dirty.delete(path)) this.notifyStore();
			} else if (this.dirty.has(path)) {
				// step: genuine divergence against unsaved local edits — the
				// user's work is never clobbered
				this.pushConsole('warn', `[vfs] ${path} changed in the store but has unsaved edits here — keeping the local version`);
			} else {
				// step: refresh the clean model; the content listener marks it
				// dirty on ANY change, so clear that mark — the store is the
				// source of this content, nothing here is unsaved
				model.setValue(text);
				this.dirty.delete(path);
				this.notifyStore();
			}
		} catch {
			// Unreadable (deleted mid-flight, transient store error) — the
			// rebuild below still runs from the models we have.
		}

		// step: re-render an attached preview from the updated truth
		if (this.previewWindow) await this.rebuild();
	}

	/** Queues/coalesces a full rebuild. */
	async rebuild(): Promise<void> {
		if (this.building) {
			this.buildQueued = true;
			return;
		}
		this.building = true;
		try {
			do {
				this.buildQueued = false;
				await this.buildOnce();
			} while (this.buildQueued && !this.disposed);
		} finally {
			this.building = false;
		}
	}

	// =========================================================================
	// INTERNALS — emit / link / inject
	// =========================================================================

	/** Emits one TS/TSX model through the worker (page-shared, content-cached). */
	private async emitOne(path: string): Promise<{ js: string; map?: string } | null> {
		const monaco = this.monaco;
		const model = this.models.get(path);
		if (!monaco || !model) return null;
		const uri = model.uri.toString();
		const version = model.getVersionId();
		const key = emitKey(uri, version);
		const cached = sharedEmitCache.get(key);
		if (cached) return cached;
		const output = await emitModel(monaco, model.uri);
		if (!output.js) return null;
		// step: drop this URI's prior-version entry before storing the new one —
		// the versioned key would otherwise leave the superseded emit resident
		for (const k of sharedEmitCache.keys()) {
			if (k.startsWith(`${uri}@`)) sharedEmitCache.delete(k);
		}
		const entry = { js: output.js, map: output.map };
		sharedEmitCache.set(key, entry);
		return entry;
	}

	/** One full build: emit changed -> instrument -> link -> inject. */
	private async buildOnce(): Promise<void> {
		const monaco = this.monaco;
		const win = this.previewWindow;
		if (!monaco || !win || this.disposed) return;
		const api = (win as unknown as { __rrShellDev?: { version: number; registerLocalApp: (id: string, load: () => Promise<unknown>, meta?: { name?: string; moduleId?: string }) => void; invalidateApp: (id: string) => void; getShareScope: () => Record<string, unknown> | undefined } }).__rrShellDev;
		const rawScope = api?.getShareScope();
		if (!api || !rawScope) {
			this.setWatch({ state: 'error', reason: 'The preview shell exposes no dev share scope — reload the preview.' });
			return;
		}
		// A v1 preview shell (pre-scope-extension bytes, e.g. browser-cached)
		// lacks the jsx runtimes and the SDK module. Fill the gaps with the
		// BUILDER's own copies: element factories are plain-object producers
		// and both realms run the same React version, so linked code still
		// binds the PREVIEW's React through the 'react' shim.
		const scope: Record<string, unknown> = { ...rawScope };
		const filled: string[] = [];
		for (const [name, local] of [['react/jsx-runtime', LocalJsxRuntime], ['react/jsx-dev-runtime', LocalJsxDevRuntime], ['rocketride', LocalRocketride]] as Array<[string, unknown]>) {
			if (!scope[name]) {
				scope[name] = local;
				filled.push(name);
			}
		}
		if (filled.length > 0) {
			this.pushConsole('warn', `[link] preview shell serves a v${(api as { version?: number }).version ?? 1} dev scope — using builder-local ${filled.join(', ')} (hard-reload the preview to pick up the current shell)`);
		}
		const started = performance.now();
		this.setWatch({ state: 'building' });

		try {
			// step: settle dependencies once per package.json state
			if (!this.deps) {
				const pkg = await readAppPackage(this.client, this.folder).catch(() => ({}));
				this.deps = await prepareDependencies(this.client, this.folder, this.appId, pkg, scope);
				for (const problem of this.deps.problems) this.pushError(`[deps] ${problem}`);
			}

			// step: emit + instrument every source module; css rides verbatim
			const linkInputs = new Map<string, LinkModule>();
			for (const [path, model] of this.models) {
				if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) {
					const emitted = await this.emitOne(path);
					if (!emitted) continue;
					if (this.refresh && path.endsWith('.tsx')) {
						linkInputs.set(path, this.refresh.instrument(emitted.js, path, emitted.map, this.sessionId));
					} else {
						linkInputs.set(path, emitted);
					}
				} else if (path.endsWith('.css')) {
					linkInputs.set(path, { js: model.getValue() });
				}
			}
			if (!linkInputs.has(ENTRY_PATH)) {
				this.setWatch({ state: 'error', reason: `The app has no ${ENTRY_PATH} — the design loop links from the descriptor root.` });
				return;
			}

			// step: link against the PREVIEW realm's share scope
			const result = await linkModules({
				appId: this.appId,
				modules: linkInputs,
				entryPath: ENTRY_PATH,
				scope,
				cssDocument: win.document,
				resolveDependency: this.deps.resolve,
			});
			this.applyMarkers(result);
			if (result.errors.length > 0 || !result.entryUrl) {
				revokeLink(result.blobUrls);
				const reason = result.errors[0]?.message ?? 'Link failed.';
				for (const err of result.errors) this.pushError(`[link] ${err.message}`, err.path);
				this.setWatch({ state: 'error', reason });
				return;
			}

			// step: inject — fresh descriptor per call, remount via invalidate
			const entryUrl = result.entryUrl;
			api.registerLocalApp(
				this.appId,
				() => import(/* webpackIgnore: true */ entryUrl).then((m: { default?: unknown }) => m.default ?? m),
				{ name: this.appName, moduleId: this.moduleId },
			);
			api.invalidateApp(this.appId);
			this.mounted = true;

			// step: retire the previous graph after the swap settles
			const previous = this.lastLink;
			this.lastLink = result;
			if (previous) setTimeout(() => revokeLink(previous.blobUrls), 5000);

			this.setWatch({ state: 'ok', durationMs: Math.round(performance.now() - started), target: 'linked in browser' });
		} catch (err) {
			this.setWatch({ state: 'error', reason: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * The hot path: rewrite ONE module against the last link's URLs, import
	 * it (its registrations overwrite the family ids), flush the refresh.
	 *
	 * @param path - The saved module's path.
	 * @param emitted - Its fresh emit output.
	 * @returns True when the hot swap succeeded (no rebuild needed).
	 */
	private async hotSwap(path: string, emitted: { js: string; map?: string }): Promise<boolean> {
		const last = this.lastLink;
		const refresh = this.refresh;
		if (!last || !refresh) return false;
		try {
			const instrumented = refresh.instrument(emitted.js, path, emitted.map, this.sessionId);
			// step: single-module relink against the existing graph
			const single = new Map<string, LinkModule>([[path, instrumented]]);
			// Reuse the full module map for RESOLUTION but only relink this
			// module: importers keep their old URLs — Fast Refresh swaps the
			// implementations by family id, not by module identity.
			const result = await linkModules({
				appId: this.appId,
				modules: new Map([...this.buildResolutionMap(), ...single]),
				entryPath: path,
				scope: (this.previewWindow as unknown as { __rrShellDev: { getShareScope: () => Record<string, unknown> } }).__rrShellDev.getShareScope(),
				cssDocument: this.previewWindow?.document ?? null,
				resolveDependency: this.deps?.resolve ?? (() => null),
			});
			if (result.errors.length > 0 || !result.entryUrl) {
				revokeLink(result.blobUrls);
				return false;
			}
			await import(/* webpackIgnore: true */ result.entryUrl);
			refresh.performRefresh();
			this.setWatch({ state: 'ok', durationMs: 0, target: 'hot refresh' });
			setTimeout(() => revokeLink(result.blobUrls), 5000);
			return true;
		} catch (err) {
			this.pushConsole('warn', `[hmr] hot swap failed — remounting: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * The resolution map for a hot relink: every module's LAST emitted form
	 * (so the saved module's relative imports resolve and land on shims /
	 * fresh blobs of their own).
	 */
	private buildResolutionMap(): Map<string, LinkModule> {
		const map = new Map<string, LinkModule>();
		for (const [path, model] of this.models) {
			if (path.endsWith('.css')) {
				map.set(path, { js: model.getValue() });
				continue;
			}
			// step: this session's paths, pulled from the shared emit cache at
			// each model's current version (populated by the build's emitOne)
			const cached = sharedEmitCache.get(emitKey(model.uri.toString(), model.getVersionId()));
			if (cached) map.set(path, { js: cached.js, map: cached.map });
		}
		return map;
	}

	/** Paints link diagnostics as Monaco markers (undeclared deps included). */
	private applyMarkers(result: LinkResult): void {
		const monaco = this.monaco;
		if (!monaco) return;
		/** path -> markers. */
		const byPath = new Map<string, MonacoEditorNs.IMarkerData[]>();
		for (const err of result.errors) {
			const model = this.models.get(err.path);
			if (!model) continue;
			// step: anchor the marker at the offending specifier when the
			// message carries one, else at the file head
			const quoted = /"([^"]+)"/.exec(err.message)?.[1];
			let range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };
			if (quoted) {
				const match = model.findMatches(quoted, false, false, true, null, false, 1)[0];
				if (match) range = match.range;
			}
			const markers = byPath.get(err.path) ?? [];
			markers.push({
				severity: monaco.MarkerSeverity.Error,
				message: err.message,
				code: err.message.includes('not a declared dependency') && quoted ? `rr-undeclared:${quoted}` : undefined,
				...range,
			});
			byPath.set(err.path, markers);
		}
		for (const [path, model] of this.models) {
			monaco.editor.setModelMarkers(model, MARKER_OWNER, byPath.get(path) ?? []);
		}
	}

	// =========================================================================
	// FEEDS
	// =========================================================================

	/** Pushes one console row (public — the provider merges build lines). */
	pushConsole(level: 'log' | 'warn' | 'error', text: string): void {
		const row: ConsoleRow = { time: feedTime(), level, text };
		this.consoleBuffer.push(row);
		if (this.consoleBuffer.length > FEED_BACKLOG) this.consoleBuffer.shift();
		for (const listener of this.consoleListeners) listener(row);
	}

	/** Pushes one error row. */
	pushError(message: string, source?: string): void {
		const row: AppErrorRow = { time: feedTime(), message, source };
		this.errorBuffer.push(row);
		if (this.errorBuffer.length > FEED_BACKLOG) this.errorBuffer.shift();
		for (const listener of this.errorListeners) listener(row);
	}

	/** Sets + broadcasts the watch status. */
	private setWatch(status: WatchStatus): void {
		this.watchStatus = status;
		for (const listener of this.watchListeners) listener(status);
	}

	/** Console feed subscription (replays the backlog). */
	subscribeConsole(listener: (row: ConsoleRow) => void): () => void {
		for (const row of this.consoleBuffer) listener(row);
		this.consoleListeners.add(listener);
		return () => this.consoleListeners.delete(listener);
	}

	/** Errors feed subscription (replays the backlog). */
	subscribeErrors(listener: (row: AppErrorRow) => void): () => void {
		for (const row of this.errorBuffer) listener(row);
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Watch feed subscription (replays the current status). */
	subscribeWatch(listener: (status: WatchStatus) => void): () => void {
		listener(this.watchStatus);
		this.watchListeners.add(listener);
		return () => this.watchListeners.delete(listener);
	}

	/** Store-change fan-out (store listeners + the VFS's subscribers). */
	private notifyStore(): void {
		for (const listener of this.storeListeners) listener();
		// step: dirty flips live in this session's set — the VFS cannot see
		// them, so announce on its bus too (the Explorer subscribes there)
		this.vfs.notify();
	}
}
