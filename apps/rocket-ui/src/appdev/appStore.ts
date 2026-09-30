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
// APP STORE — the .appdev VFS: the web App Builder's working copies
// =============================================================================

/**
 * Store-VFS helpers for the web App Builder. Each app is a folder under
 * `.appdev/<name>-ui/` in the user's server-side file store (beside the
 * `.projects`-prefixed pipeline files) holding the app's SOURCE truth:
 * package.json (with the appManifest binding block), tsconfig.json, src/**.
 *
 * This is the web twin of the VSCode workspace scan (appScan.ts): the
 * sidebar lists what you can open and edit here — server registry state
 * deliberately not merged in.
 */

import { PROJECT_DIR } from 'rocketride';
import { ConnectionManager } from 'shell';
import type { RocketRideClient } from 'shell';
import { renderTemplate } from 'shared/modules/appdev';
import type { FrameOptions, PackageJsonLike, TemplateName } from 'shared/modules/appdev';

// =============================================================================
// PATHS
// =============================================================================

/** The App Builder's working-copy directory inside the project store. */
export const APPDEV_DIR = '.appdev';

/** Preview-size cap for app text/image reads (matches the VSCode host). */
const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * The store path of a file inside an app folder.
 *
 * @param folder - The app's folder name under .appdev (e.g. 'brandy-ui').
 * @param rel - App-folder-relative POSIX path ('' = the folder itself).
 * @returns The full store path.
 */
export function appPath(folder: string, rel = ''): string {
	return rel ? `${PROJECT_DIR}/${APPDEV_DIR}/${folder}/${rel}` : `${PROJECT_DIR}/${APPDEV_DIR}/${folder}`;
}

// =============================================================================
// CHANGE NOTIFICATION
// =============================================================================

/** Page-monotonic revision counter for onFsChange notifications. */
let fsChangeRev = 0;

/**
 * Announces one store-VFS write on the shell notification bus
 * (`shell:notify` / kind `onFsChange`). Called AFTER the server write
 * resolves, so a listener that re-reads the path sees the new content.
 * Page-local by design: same-realm listeners only — cross-tab and
 * cross-client delivery is the future server-pushed feed's job.
 *
 * @param uri - The full store path that changed.
 * @param origin - The writer's identity (a dev-session id, or a verb like
 *                 'scaffold') — listeners skip their own echo.
 */
export function emitFsChange(uri: string, origin: string): void {
	ConnectionManager.getInstance().emit('shell:notify', { kind: 'onFsChange', uri, origin, rev: ++fsChangeRev });
}

/**
 * Guards an app-folder-relative path against traversal — the store client
 * validates path shapes too, but the manifest can name anything and the
 * refusal should be local and explicit.
 *
 * @param rel - The './'-prefixed or bare relative path from the manifest.
 * @returns The normalized relative path.
 */
function safeRel(rel: string): string {
	const normalized = rel.replace(/^\.\//, '');
	if (normalized.startsWith('/') || normalized.split('/').some((seg) => seg === '..' || seg === '')) {
		throw new Error('Path escapes the app folder.');
	}
	return normalized;
}

// =============================================================================
// SCAN
// =============================================================================

/** One scanned working copy under .appdev. */
export interface StoredApp {
	/** App id (appManifest.id). */
	id: string;
	/** Display name (appManifest.name, falling back to the pkg name). */
	name: string;
	/** MF container name (appManifest.moduleId, or derived from the id). */
	moduleId: string;
	/** The folder name under .appdev. */
	folder: string;
	/** Top-level package.json semver. */
	version: string;
	/** Listing description (appManifest.description). */
	description: string;
}

/**
 * Lists the folder names under .appdev ([] when the directory does not
 * exist yet — nothing has been scaffolded).
 *
 * @param client - The connected RocketRide client.
 * @returns Folder names, unsorted.
 */
export async function listAppFolders(client: RocketRideClient): Promise<string[]> {
	try {
		const result = await client.fsListDir(`${PROJECT_DIR}/${APPDEV_DIR}`);
		return (result.entries ?? []).filter((e) => e.type === 'dir').map((e) => e.name);
	} catch {
		return [];
	}
}

/**
 * Scans every .appdev working copy: one row per folder whose package.json
 * carries an appManifest with an id. Unreadable folders are skipped, not
 * fatal — a half-written scaffold must not hide the rest of the list.
 *
 * @param client - The connected RocketRide client.
 * @returns The scanned apps, sorted by display name.
 */
export async function scanApps(client: RocketRideClient): Promise<StoredApp[]> {
	const folders = await listAppFolders(client);
	const apps: StoredApp[] = [];
	for (const folder of folders) {
		try {
			const pkg = await readAppPackage(client, folder);
			const m = (pkg.appManifest ?? {}) as Record<string, unknown>;
			if (typeof m.id !== 'string' || !m.id) continue;
			apps.push({
				id: m.id,
				name: typeof m.name === 'string' && m.name ? m.name : (pkg.name ?? m.id),
				moduleId: typeof m.moduleId === 'string' && m.moduleId ? m.moduleId : m.id.replace(/[^a-zA-Z0-9_$]/g, '_'),
				folder,
				version: typeof pkg.version === 'string' ? pkg.version : '',
				description: typeof m.description === 'string' ? m.description : '',
			});
		} catch {
			continue;
		}
	}
	return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// =============================================================================
// PACKAGE.JSON ROUND-TRIP
// =============================================================================

/**
 * Reads and parses an app folder's package.json.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @returns The parsed package.json object.
 */
export async function readAppPackage(client: RocketRideClient, folder: string): Promise<PackageJsonLike> {
	return JSON.parse(await client.fsReadString(appPath(folder, 'package.json'))) as PackageJsonLike;
}

/**
 * Serializes and writes an app folder's package.json (tab-indented, like
 * the scaffold emits it), announcing the write on the notification bus.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param pkg - The parsed package.json object to persist.
 * @param origin - The writer's identity for the onFsChange notification
 *                 ('' when the writer holds no dev session, e.g. the
 *                 Store pane's listing save).
 */
export async function writeAppPackage(client: RocketRideClient, folder: string, pkg: PackageJsonLike, origin = ''): Promise<void> {
	const uri = appPath(folder, 'package.json');
	await client.fsWriteString(uri, `${JSON.stringify(pkg, null, '\t')}\n`);
	emitFsChange(uri, origin);
}

// =============================================================================
// FILE READS (preview surfaces)
// =============================================================================

/**
 * Reads one app-folder-relative TEXT file for preview (icon SVG, README
 * markdown). Traversal-guarded; size-capped after the read (the store has
 * no cheap stat, and preview files are small by convention).
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns The file text.
 */
export async function readAppText(client: RocketRideClient, folder: string, relPath: string): Promise<string> {
	const text = await client.fsReadString(appPath(folder, safeRel(relPath)));
	if (text.length > MAX_PREVIEW_BYTES) throw new Error('File is over the 512KB preview limit.');
	return text;
}

/** Media types the image reader inlines, by extension. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

/**
 * Reads one app-folder-relative IMAGE as a data: URI (README images are
 * binary — a text read would corrupt them). Uses the batch read op for the
 * one-shot binary fetch.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns The data: URI, or null for unreadable/unsupported/oversized files.
 */
export async function readAppImageDataUri(client: RocketRideClient, folder: string, relPath: string): Promise<string | null> {
	const rel = safeRel(relPath);
	const ext = rel.split('.').pop()?.toLowerCase() ?? '';
	const mime = IMAGE_MEDIA_TYPES[ext];
	if (!mime) return null;
	const [entry] = await client.fsReadMany([appPath(folder, rel)]);
	if (!entry?.ok || !entry.data || entry.data.byteLength > MAX_PREVIEW_BYTES) return null;
	// step: base64-encode in chunks — String.fromCharCode(...whole) overflows
	// the argument limit on large files.
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < entry.data.byteLength; i += CHUNK) {
		binary += String.fromCharCode(...entry.data.subarray(i, i + CHUNK));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Whether an app-folder-relative file exists in the store.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns True when readable.
 */
export async function appFileExists(client: RocketRideClient, folder: string, relPath: string): Promise<boolean> {
	try {
		const [entry] = await client.fsReadMany([appPath(folder, safeRel(relPath))]);
		return !!entry?.ok;
	} catch {
		return false;
	}
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/** Inputs for a new-app scaffold into the store VFS. */
export interface ScaffoldRequest {
	/** The app-name slug (the half after the dot in the app id). */
	appName: string;
	/** Human-readable display name. */
	displayName: string;
	/** Publisher slug (the org developer id, or 'local'). */
	publisher: string;
	/** Frame options composing the generated App.tsx. */
	frame: FrameOptions;
	/** Template to render (defaults to 'Blank'). */
	template?: TemplateName;
}

/**
 * Scaffolds a new app into `.appdev/<appName>-ui/`: renders the shared
 * template set and writes every file into the store VFS. Nothing else — no
 * install, no tgz vendoring (the design loop compiles in the browser and
 * the server build materializes its own toolchain).
 *
 * @param client - The connected RocketRide client.
 * @param req - The scaffold inputs.
 * @returns The created app's id and folder name.
 */
export async function scaffoldApp(client: RocketRideClient, req: ScaffoldRequest): Promise<{ appId: string; folder: string }> {
	const appId = `${req.publisher}.${req.appName}`;
	const folder = `${req.appName}-ui`;

	// step: refuse a live collision (the form checks too, but the scan can
	// be stale by the time Create lands)
	const existing = await listAppFolders(client);
	if (existing.includes(folder)) throw new Error(`Folder "${APPDEV_DIR}/${folder}" already exists.`);

	// step: render the shared template set — identical files to the VSCode
	// scaffold, so the packed source is host-independent
	const files = renderTemplate(req.template ?? 'Blank', {
		appId,
		appName: req.displayName,
		publisher: req.publisher,
		moduleId: appId.replace(/[^a-zA-Z0-9_$]/g, '_'),
		port: 3011,
		previewUrl: `${window.location.origin}/?appid=${encodeURIComponent(appId)}&rrdev=1`,
	}, req.frame);

	// step: write every file (nested store paths create parents implicitly)
	for (const file of files) {
		const uri = appPath(folder, file.path);
		await client.fsWriteString(uri, file.content);
		emitFsChange(uri, 'scaffold');
	}

	return { appId, folder };
}
