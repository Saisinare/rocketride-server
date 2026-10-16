// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarView — Unified sidebar container for pipeline management.
 *
 * Composes the generic Explorer component (file tree) with pipeline-specific
 * UI: navigation buttons, unknown tasks section, and a footer slot.
 *
 * Column order: shared nav (host slot), then the stock TabControl
 * mode tabs (Agent | Apps | Nodes | Pipelines — Agent when the host wires
 * the agent sidebar, Apps when it wires the app builder, Nodes as the
 * node-builder placeholder), then a stock TabPanel holding the mode bodies,
 * then the shared footer slot.
 *
 * The Explorer component handles all file tree rendering, inline rename/create,
 * context menus, status indicators, and child item actions.  SidebarView
 * just wraps it with app-specific chrome.
 */

import React, { useState, useCallback, CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { BxPlus, BxChevronRight, BxChevronDown, BxDesktop, BxStop, BxGridAlt, BxTrash, BxNote } from 'shell';
import { SidebarMenu, TabControl, TabPanel } from 'shell';
import { Explorer, NOOP_VFS } from 'shell';
import { CodiconCircuitBoard, CodiconTypeHierarchy, CodiconExtensions } from '../../components/icons/Codicon';
import { AppsIcon } from '../../components/icons/AppsIcon';
import type { ISidebarViewProps, ToolTab } from './types';
import type { ViewMenu } from 'shell';
import type { ExplorerEntry, ExplorerStatus, ExplorerConfig } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		fontFamily: 'var(--rr-font-family, system-ui, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
	} as CSSProperties,
	// No horizontal padding: the SidebarMenu inside carries its own tree-list
	// padding (2px 6px), so adding more here would indent nav rows past the
	// Explorer rows and break the sidebar's shared left rhythm.
	navSection: {
		padding: '8px 0 12px',
		flexShrink: 0,
	} as CSSProperties,
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		position: 'relative' as const,
	} as CSSProperties,
	rowName: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	spacer: { flex: 1 } as CSSProperties,
	dot: (color: string): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: color,
		flexShrink: 0,
	}),
	actionBtn: (color: string): CSSProperties => ({
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
	}),
	// Wrapper giving the TabPanel stack the remaining column height (the
	// stock TabPanel sizes itself to 100% of its parent). The top padding
	// separates the strip from whichever mode body renders beneath it.
	panelStack: {
		flex: 1,
		minHeight: 0,
		paddingTop: 8,
		boxSizing: 'border-box' as const,
	} as CSSProperties,
	// One mode body inside the TabPanel stack — its own full-height column
	// so the Explorer / apps list keep their internal flex scrolling.
	panelColumn: {
		display: 'flex',
		flexDirection: 'column' as const,
		height: '100%',
	} as CSSProperties,
	// MY APPS header — the Explorer's section-header treatment (same label
	// style and left offset). The 24px line height reproduces the row height
	// the Explorer's header gets from its 16px+4px-padding action buttons, so
	// the two labels sit at the same vertical position across the mode tabs.
	appsLabel: {
		...commonStyles.labelUppercase,
		padding: '6px 12px 4px',
		lineHeight: '24px',
		flexShrink: 0,
	} as CSSProperties,
	// MY APPS list — the Explorer's tree-list padding, so app rows align
	// with pipeline rows across the mode tabs.
	appsList: {
		padding: '2px 6px',
		flex: 1,
		minHeight: 0,
		overflowY: 'auto' as const,
	} as CSSProperties,
	// App row icon — the app's own icon in the 16px slot the generic
	// glyph occupies, so rows align either way.
	appIcon: {
		width: 16,
		height: 16,
		flexShrink: 0,
		objectFit: 'contain',
	} as CSSProperties,
	// Placeholder body for not-yet-built modes (the Explorer empty-state
	// treatment: centered muted text).
	comingSoon: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
	// Tool panel header — icon chip + name/version, mirroring the MY APPS row
	// rhythm at panel scale.
	toolHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '10px 12px 6px',
	} as CSSProperties,
	toolIcon: {
		width: 28,
		height: 28,
		flexShrink: 0,
		borderRadius: 6,
		objectFit: 'contain' as const,
	} as CSSProperties,
	// Modules-list row (the Dev Tools catalog) — two-line extensions-style.
	storeRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '6px 10px',
		borderRadius: 5,
		cursor: 'pointer',
		userSelect: 'none' as const,
	} as CSSProperties,
	storeRowIcon: {
		width: 26,
		height: 26,
		flexShrink: 0,
		objectFit: 'contain' as const,
	} as CSSProperties,
	storeInstalled: {
		flexShrink: 0,
		fontSize: 10,
		fontWeight: 600,
		padding: '1px 7px',
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	// Tool tab glyph on the strip — display:block kills the inline-image
	// baseline gap so the tab's box (and its underline) matches the SVG-icon
	// tabs exactly; grayscale keeps the strip monochrome (the built-in mode
	// icons draw in currentColor, and a full-color app icon would shout).
	// Tool tab glyph on the strip — the icon is a CSS MASK filled with
	// currentColor, so it renders in the tab's own text color exactly like
	// the codicon tabs (active/inactive shift included) instead of a
	// grayscaled version of the app's brand color.
	toolTabIcon: {
		width: 16,
		height: 16,
		display: 'block' as const,
		backgroundColor: 'currentColor',
		WebkitMaskSize: 'contain',
		maskSize: 'contain',
		WebkitMaskRepeat: 'no-repeat',
		maskRepeat: 'no-repeat',
		WebkitMaskPosition: 'center',
		maskPosition: 'center',
	} as CSSProperties,
};

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// SESSION DATE FORMATTING
// =============================================================================

/**
 * Formats a session stamp for the MY SESSIONS meta line: minutes/hours for
 * today ("12m ago", "3h ago"), "yesterday", then a short month-day ("Sep 24").
 *
 * @param date - Epoch-ms creation stamp.
 * @returns The human-relative label.
 */
function formatSessionDate(date: number): string {
	const elapsed = Date.now() - date;
	if (elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
	if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
	if (elapsed < 2 * 86_400_000) return 'yesterday';
	return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// =============================================================================
// DEFAULT EXPLORER CONFIG
// =============================================================================

/** Default configuration for the pipeline Explorer panel. */
const PIPELINE_CONFIG: ExplorerConfig = {
	title: 'My Pipelines',
	extensions: ['.pipe', '.pipe.json'],
	displayName: (name: string) => name.replace(/\.pipe(?:\.json)?$/, '') || name,
	createPlaceholder: 'pipeline name',
	emptyMessage: 'No pipeline files',
};

// =============================================================================
// TOOL STORE PANEL — the modules list behind the strip's Dev Tools button
// =============================================================================

/**
 * The dev-tool catalog, VS Code extensions-view style: one row per available
 * tool (icon, name, version, description, Installed marker). Clicking a row
 * opens the tool's details page (README + Install/Remove) via `onShowTool`.
 */
const ToolStorePanel: React.FC<{ available: ToolTab[]; installedIds: Set<string>; onShowTool: (id: string) => void }> = ({ available, installedIds, onShowTool }) => {
	const [hovered, setHovered] = useState<string | null>(null);
	return (
		<div style={S.panelColumn}>
			<div style={S.appsLabel}>Dev Tools</div>
			<div style={S.appsList}>
				{available.length === 0 && (
					<div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' }}>
						No dev tools are published on this server.
					</div>
				)}
				{available.map((t) => (
					<div
						key={t.id}
						style={{ ...S.storeRow, ...(hovered === t.id ? { background: HOVER_BG } : {}) }}
						onMouseEnter={() => setHovered(t.id)}
						onMouseLeave={() => setHovered(null)}
						onClick={() => onShowTool(t.id)}
					>
						{t.iconUrl ? <img src={t.iconUrl} alt="" style={S.storeRowIcon} /> : <div style={S.storeRowIcon} />}
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
								<span style={{ fontWeight: 600, ...commonStyles.textEllipsis }}>{t.name}</span>
								{t.version && <span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', flexShrink: 0 }}>{t.version}</span>}
							</div>
							{t.description && (
								<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', ...commonStyles.textEllipsis }}>{t.description}</div>
							)}
						</div>
						{installedIds.has(t.id) && <span style={S.storeInstalled}>Installed</span>}
					</div>
				))}
			</div>
		</div>
	);
};

// =============================================================================
// TOOL PANEL — the built-in body behind a pinned dev tool's tab
// =============================================================================

/**
 * Default panel for a dev-tool tab: icon, name, version, and the Open /
 * Remove rows. Hosts replace it via `toolTabs.renderToolPanel` once they
 * mount the tool's own devToolSidebar here — exported so their mount
 * components can fall back to it for tools without a devToolSidebar.
 */
export const ToolPanel: React.FC<{ tool: ToolTab; onOpen: (id: string) => void; onRemove: (id: string) => void }> = ({ tool, onOpen, onRemove }) => {
	const navMenu: ViewMenu = {
		entries: [
			{ id: 'open', label: `Open ${tool.name}`, icon: <BxGridAlt size={16} /> },
			{ id: 'remove', label: 'Remove from tools', icon: <BxTrash size={16} /> },
		],
	};
	return (
		<div style={S.panelColumn}>
			<div style={S.toolHeader}>
				{tool.iconUrl && <img src={tool.iconUrl} alt="" style={S.toolIcon} />}
				<div style={{ minWidth: 0 }}>
					<div style={{ fontWeight: 600, ...commonStyles.textEllipsis }}>{tool.name}</div>
					{tool.version && <div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{tool.version}</div>}
				</div>
			</div>
			<div style={S.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'open') onOpen(tool.id);
						if (id === 'remove') onRemove(tool.id);
					}}
				/>
			</div>
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SidebarView — pipeline sidebar container that composes Explorer with
 * navigation buttons, unknown tasks, and a footer slot.
 *
 * Maps ISidebarViewProps (pipeline-specific) to IExplorerProps (generic).
 * The Explorer component handles all file tree rendering internally.
 */
export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, isSubscribed = true, entries, activeTasks, unknownTasks, headerSlot, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, activeFilePath, appBuilder, agent, showModeStrip = false, hideModeStrip = false, sidebarMode = 'pipelines', onSidebarModeChange, onShowIntro, onShowDesktop, toolTabs, tabOrder, onReorderTabs }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const isConnected = connection.state === 'connected';
	const hasUnknown = (unknownTasks?.length ?? 0) > 0;
	// The Agent and Apps tabs exist only when the host wires them; the Nodes
	// tab exists whenever the mode tabs render at all. A requested mode is
	// only honored when its tab actually exists — anything else falls back
	// to Pipelines.
	const hasAppBuilder = Boolean(appBuilder);
	const hasAgent = Boolean(agent);
	const tools = toolTabs?.tools ?? [];
	// `hideModeStrip` wins: the hosting chrome (shell workbench rail) owns the
	// selection and the strip would be a second, competing switcher. Mode
	// VALIDATION stays on "are modes wired at all" rather than on the strip's
	// visibility, so a rail-driven 'nodes' still lands on the Nodes body.
	const modesWired = hasAppBuilder || hasAgent || Boolean(toolTabs) || showModeStrip || hideModeStrip;
	const tabsVisible = !hideModeStrip && (hasAppBuilder || hasAgent || Boolean(toolTabs) || showModeStrip);
	// --- Static nav menus ----------------------------------------------------

	// "+ New pipeline" belongs to the Pipelines tab body only; the embedded
	// Introduction row sits right above it when the host wires onShowIntro.
	const pipelinesNavMenu: ViewMenu = {
		entries: [...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Pipelines', icon: <BxNote size={16} /> }] : []), { id: 'new', label: 'New pipeline', icon: <BxPlus size={16} /> }],
	};

	// The mode tabs — the stock TabControl menu. The Agent and Apps entries
	// only exist when the host wires their sidebar content; Nodes (the
	// node-builder placeholder) rides along whenever the tabs render.
	// Icons mirror the rocket-ui workbench rail (RocketApp.tsx) so the same
	// mode wears the same glyph in both hosts; the strip renders icon-only
	// (labels become tooltips). Agent has no shared glyph yet — its entry
	// falls back to the text label (the rocket-ui host hides this strip).
	// Pinned dev-tool tabs ride the same strip after the fixed modes — one
	// icon tab per tool (manifest icon; name as the tooltip). When the host
	// wires onReorderTabs, EVERY tab is draggable and the persisted tabOrder
	// re-ranks the default sequence (ids it names first, in its order; the
	// rest keep their default position after them).
	const reorderable = Boolean(onReorderTabs);
	const baseEntries = [
		...(hasAgent ? [{ id: 'agent', label: 'Agent', draggable: reorderable }] : []),
		...(hasAppBuilder ? [{ id: 'apps', label: 'Apps', icon: <AppsIcon size={16} />, draggable: reorderable }] : []),
		{ id: 'nodes', label: 'Nodes', icon: <CodiconCircuitBoard size={16} />, draggable: reorderable },
		{ id: 'pipelines', label: 'Pipelines', icon: <CodiconTypeHierarchy size={16} />, draggable: reorderable },
		// A tool tab only exists once its icon is in hand — rendering the
		// name as a fallback flashes text into an icon strip.
		...tools.filter((t) => t.iconUrl).map((t) => ({
			id: `tool:${t.id}`,
			label: t.name,
			icon: <span style={{ ...S.toolTabIcon, WebkitMaskImage: `url(${t.iconUrl})`, maskImage: `url(${t.iconUrl})` }} />,
			draggable: reorderable,
		})),
		// The Dev Tools catalog is a REGULAR tab like the modes: reorderable,
		// never removable — selecting it shows the modules list.
		...(toolTabs ? [{ id: 'toolStore', label: 'Dev Tools', icon: <CodiconExtensions size={16} />, draggable: reorderable }] : []),
	];
	const rank = new Map((tabOrder ?? []).map((id, i) => [id, i]));
	const modeMenu: ViewMenu = {
		entries: baseEntries
			.map((entry, baseIndex) => ({ entry, baseIndex }))
			.sort((a, b) => {
				const ra = rank.get(a.entry.id);
				const rb = rank.get(b.entry.id);
				if (ra !== undefined && rb !== undefined) return ra - rb;
				if (ra !== undefined) return -1;
				if (rb !== undefined) return 1;
				return a.baseIndex - b.baseIndex;
			})
			.map(({ entry }) => entry),
	};
	// A requested mode is only honored when its tab actually exists —
	// membership in the menu IS the wiredness check (tool tabs come and go
	// with pinning; the Dev Tools catalog tab exists whenever tools are
	// wired); anything else falls back to Pipelines.
	const mode = modesWired && modeMenu.entries.some((e) => e.id === sidebarMode) ? sidebarMode : 'pipelines';

	// --- Map pipeline entries → Explorer entries -----------------------------

	const explorerEntries: ExplorerEntry[] = entries.map((e) => ({
		path: e.path,
		type: e.type,
		documentId: e.projectId,
		children: e.sources?.map((s) => ({ id: s.id, name: s.name, provider: s.provider })),
	}));

	// --- Map activeTasks → Explorer statuses ---------------------------------

	const explorerStatuses = activeTasks as Map<string, ExplorerStatus>;

	// --- Child action handler (run/stop sources) -----------------------------

	const handleChildAction = useCallback(
		(action: 'run' | 'stop', filePath: string, childId: string, documentId?: string) => {
			onSourceAction(action, filePath, childId, documentId);
		},
		[onSourceAction]
	);

	// --- Nav hover helpers ---------------------------------------------------

	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});

	// --- Render --------------------------------------------------------------

	// --- MY APPS nav (App Builder mode) --------------------------------------

	// "+ New app" as a stock SidebarMenu entry, mirroring "New pipeline"; the
	// embedded Introduction row sits right above it.
	const appsNavMenu: ViewMenu = {
		entries: [...(onShowDesktop ? [{ id: 'desktop', label: 'Desktop', icon: <BxDesktop size={16} /> }] : []), ...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Apps', icon: <BxNote size={16} /> }] : []), { id: 'newApp', label: 'New app', icon: <BxPlus size={16} /> }],
	};

	// --- MY SESSIONS nav (Agent mode) -----------------------------------------

	// "+ New session" as a stock SidebarMenu entry, mirroring "New app"; the
	// embedded Introduction row sits right above it.
	const agentNavMenu: ViewMenu = {
		entries: [...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Agents', icon: <BxNote size={16} /> }] : []), { id: 'newSession', label: 'New session', icon: <BxPlus size={16} /> }],
	};

	// --- Mode bodies ---------------------------------------------------------

	// Pipelines tab body: + New pipeline nav, the Explorer tree, and the
	// ad-hoc (unknown-task) section.
	const pipelinesPanel = (
		<div style={S.panelColumn}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				{/* "+ New pipeline" as a stock SidebarMenu. No persistent selection
				    (activeId=''); the id-narrowing guard keeps onNavigate's union
				    contract without a cast. SidebarMenu reads the collapsed flag
				    from context, so no explicit collapsed prop is wired here. */}
				<SidebarMenu
					menu={pipelinesNavMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'new') onNavigate(id);
						if (id === 'intro') onShowIntro?.('pipelines');
					}}
				/>
			</div>

			{/* ── Explorer (file tree) ────────────────────────────────── */}
			{/* vfs must be passed (frozen shell-contract shape) but is unused —
			    the typed no-op replaces the old `null as any` cast. */}
			<Explorer vfs={NOOP_VFS} config={PIPELINE_CONFIG} entries={explorerEntries} statuses={explorerStatuses} isConnected={isConnected} showChildActions={isSubscribed} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onFileManage={onFileManage} fileActions={fileActions} onChildAction={handleChildAction} onRefresh={onRefresh} />

			{/* ── Unknown tasks (AD-HOC) — server tasks with no .pipe file */}
			{hasUnknown && (
				<div style={{ padding: '2px 6px', flexShrink: 0 }}>
					<div style={{ ...S.row, marginTop: 4, ...hoverBg('unknown-root') }} onMouseEnter={() => setHoveredRow('unknown-root')} onMouseLeave={() => setHoveredRow(null)} onClick={() => setUnknownExpanded((p) => !p)}>
						{unknownExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
						<span style={{ ...S.rowName, ...commonStyles.labelUppercase, color: 'var(--rr-text-secondary)' }}>Ad-hoc</span>
						<span style={S.spacer} />
						<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{unknownTasks!.length} running</span>
					</div>
					{unknownExpanded &&
						unknownTasks!.map((ut) => {
							const utKey = `ut:${ut.projectId}:${ut.sourceId}`;
							return (
								<div key={utKey} style={{ ...S.row, paddingLeft: 28, ...hoverBg(utKey) }} onMouseEnter={() => setHoveredRow(utKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onOpenUnknownTask?.(ut.projectId, ut.sourceId, ut.displayName)} title={`Project: ${ut.projectId}\nSource: ${ut.sourceId}\nRunning (no local .pipe file)`}>
									<div style={S.dot('var(--rr-color-success)')} />
									<span style={S.rowName}>{ut.displayName}</span>
									<span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginLeft: 4 }}>{ut.projectLabel}</span>
									<span style={S.spacer} />
									{hoveredRow === utKey && isConnected && (
										<button
											style={S.actionBtn('var(--rr-color-error)')}
											title="Stop"
											onClick={(e) => {
												e.stopPropagation();
												onSourceAction('stop', '', ut.sourceId, ut.projectId);
											}}
										>
											<BxStop size={16} />
										</button>
									)}
								</div>
							);
						})}
				</div>
			)}
		</div>
	);

	// Apps tab body: + New app nav and the MY APPS list.
	const appsPanel = appBuilder ? (
		<div style={S.panelColumn}>
			<div style={S.navSection}>
				<SidebarMenu
					menu={appsNavMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newApp') appBuilder.onNewApp();
						if (id === 'intro') onShowIntro?.('apps');
						if (id === 'desktop') onShowDesktop?.();
					}}
				/>
			</div>
			<div style={S.appsLabel}>My Apps</div>
			<div style={S.appsList}>
				{appBuilder.apps.length === 0 && (
					<div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' }}>
						No apps yet. Create one with New app.
					</div>
				)}
				{appBuilder.apps.map((app) => {
					const rowKey = `app:${app.id}`;
					const active = app.id === appBuilder.activeAppId;
					return (
						<div
							key={app.id}
							style={{ ...S.row, ...(active ? { background: HOVER_BG } : hoverBg(rowKey)) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => appBuilder.onOpenApp(app.id)}
							title={app.folder ? `${app.id}\n${app.folder}` : app.id}
						>
							{/* Mirror the Explorer file-row anatomy — 14px chevron slot
							    (apps don't expand) + 16px leading icon — so app icons and
							    names align column-for-column with the pipeline rows. */}
							<span style={{ width: 14, flexShrink: 0 }} />
							{app.iconUrl ? (
								<img src={app.iconUrl} alt="" style={S.appIcon} />
							) : (
								<BxGridAlt size={16} color="var(--rr-text-secondary)" />
							)}
							<span style={S.rowName}>{app.name}</span>
						</div>
					);
				})}
			</div>
		</div>
	) : null;

	// Agent tab body: + New session nav and the MY SESSIONS list.
	const agentPanel = agent ? (
		<div style={S.panelColumn}>
			<div style={S.navSection}>
				<SidebarMenu
					menu={agentNavMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newSession') agent.onNewSession();
						if (id === 'intro') onShowIntro?.('agent');
					}}
				/>
			</div>
			<div style={S.appsLabel}>My Sessions</div>
			<div style={S.appsList}>
				{agent.sessions.length === 0 && (
					<div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' }}>
						No sessions yet — start one with New session.
					</div>
				)}
				{agent.sessions.map((session) => {
					const rowKey = `sess:${session.sessionId}`;
					const active = session.sessionId === agent.activeSessionId;
					return (
						<div
							key={session.sessionId}
							role="button"
							tabIndex={0}
							style={{ ...S.row, alignItems: 'flex-start', ...(active ? { background: HOVER_BG } : hoverBg(rowKey)) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							// step: keyboard parity — focus marks the row (the hover-gated
							// delete button needs a reachable target), Enter/Space opens it
							onFocus={() => setHoveredRow(rowKey)}
							onBlur={(e) => {
								if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredRow((prev) => (prev === rowKey ? null : prev));
							}}
							onKeyDown={(e) => {
								// only the ROW itself — the nested delete button's
								// Enter/Space bubbles here and must keep deleting
								if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
								e.preventDefault();
								agent.onOpenSession(session.sessionId);
							}}
							onClick={() => agent.onOpenSession(session.sessionId)}
							title={session.title}
						>
							{/* Two-line row: title over the relative date; the 14px
							    chevron slot keeps alignment with the other modes. */}
							<span style={{ width: 14, flexShrink: 0 }} />
							<div style={{ flex: 1, minWidth: 0, padding: '2px 0' }}>
								<div style={S.rowName}>{session.title}</div>
								<div style={{ fontSize: 11, lineHeight: '14px', color: 'var(--rr-text-secondary)' }}>{formatSessionDate(session.date)}</div>
							</div>
							{hoveredRow === rowKey && (
								<button
									style={S.actionBtn('var(--rr-text-secondary)')}
									title="Delete session"
									onClick={(e) => {
										e.stopPropagation();
										agent.onDeleteSession(session.sessionId);
									}}
								>
									<BxTrash size={14} />
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	) : null;

	// The Nodes Introduction row — the only nav the placeholder mode has.
	const nodesNavMenu: ViewMenu = {
		entries: [{ id: 'intro', label: 'Introduction to Nodes', icon: <BxNote size={16} /> }],
	};

	// Nodes tab body: the Introduction row above the node-builder placeholder.
	const nodesPanel = (
		<div style={S.panelColumn}>
			{onShowIntro && (
				<div style={S.navSection}>
					<SidebarMenu
						menu={nodesNavMenu}
						activeId=""
						onSelect={(id) => {
							if (id === 'intro') onShowIntro('nodes');
						}}
					/>
				</div>
			)}
			<div style={S.comingSoon}>Coming soon...</div>
		</div>
	);

	return (
		<div style={S.container}>
			{/* ── Host-injected nav above the mode tabs (e.g. rocket-ui's
			    Home button). Rendered only when the host passes a slot, so
			    VS Code (no slot) gets zero DOM/spacing. ─────────────────── */}
			{headerSlot != null && <div style={S.navSection}>{headerSlot}</div>}

			{/* ── Mode tabs — the stock TabControl strip: Apps tab when
			    wired, Nodes placeholder always; strip alone forced by the
			    web host (future modes land here) ──────────────────────── */}
			{tabsVisible && (
				<TabControl
					menu={modeMenu}
					iconsOnly
					activeId={mode}
					onSelect={(id) => {
						// Membership in the menu is the validity check (fixed modes
						// AND tool tabs). Selecting a tool tab brings an already-open
						// window of the tool forward (never creates one); hosts
						// without that distinction fall back to open-or-focus.
						if (!modeMenu.entries.some((e) => e.id === id)) return;
						onSidebarModeChange?.(id as typeof mode);
						if (id.startsWith('tool:')) (toolTabs?.onFocusTool ?? toolTabs?.onOpenTool)?.(id.slice('tool:'.length));
					}}
					onReorder={onReorderTabs ? (dragId, targetId, position) => {
						// Rebuild the DISPLAYED order with the dragged tab
						// inserted beside the target, and hand the host the
						// full ordered id list to persist.
						const order = modeMenu.entries.map((e) => e.id).filter((id) => id !== dragId);
						const at = order.indexOf(targetId);
						if (at < 0) return;
						order.splice(position === 'before' ? at : at + 1, 0, dragId);
						onReorderTabs(order);
					} : undefined}
				/>
			)}

			{/* ── Mode bodies — the stock TabPanel stack keeps all modes
			    mounted, so Explorer scroll/expand state survives switches */}
			<div style={S.panelStack}>
				<TabPanel
					activeId={mode}
					panels={{
						pipelines: { content: pipelinesPanel },
						...(agentPanel ? { agent: { content: agentPanel } } : {}),
						...(appsPanel ? { apps: { content: appsPanel } } : {}),
						nodes: { content: nodesPanel },
						...(toolTabs
							? {
								toolStore: { content: <ToolStorePanel available={toolTabs.available} installedIds={new Set(tools.map((t) => t.id))} onShowTool={toolTabs.onShowTool} /> },
								...Object.fromEntries(tools.map((t) => [
									`tool:${t.id}`,
									{ content: toolTabs.renderToolPanel?.(t.id) ?? <ToolPanel tool={t} onOpen={toolTabs.onOpenTool} onRemove={toolTabs.onRemoveTool} /> },
								])),
							}
							: {}),
					}}
				/>
			</div>

			{/* ── Footer slot (shared by both modes) ──────────────────── */}
			{footerSlot}
		</div>
	);
};
