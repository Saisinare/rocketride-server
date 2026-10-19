// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * RawReply — the small disclosure under a status row that has a `detail`
 * (for the agent, the model's raw reply). Closed it is one "Raw reply" toggle,
 * so a long reply costs nothing in the thread; open it shows the text exactly
 * as it is, in a monospace block with a bounded height that scrolls.
 */

import React, { useState, type CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The toggle shrinks to its label and the block below spans the row, so the
	// block is the same width whether the reply is short or long.
	root: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-start',
		alignSelf: 'stretch',
		minWidth: 0,
	} as CSSProperties,

	// The toggle matches the Thinking group's: a caption-coloured button with a
	// small triangle that turns when open, one size down.
	toggle: {
		display: 'flex',
		alignItems: 'center',
		gap: 5,
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '1px 0',
		color: 'var(--rr-text-caption)',
		fontSize: 10.5,
	} as CSSProperties,

	chevron: (open: boolean): CSSProperties => ({
		width: 0,
		height: 0,
		borderLeft: '3px solid transparent',
		borderRight: '3px solid transparent',
		borderTop: '4px solid currentColor',
		transition: 'transform 0.15s',
		transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
	}),

	// The reply as written: line breaks and spaces kept, long lines wrapped,
	// at most 240px tall and scrolling past that. Same look as inline code.
	block: {
		alignSelf: 'stretch',
		boxSizing: 'border-box',
		margin: '4px 0 2px',
		padding: '6px 8px',
		maxHeight: 240,
		overflow: 'auto',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		lineHeight: 1.45,
		fontStyle: 'normal',
		color: 'var(--rr-text-secondary)',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		scrollbarWidth: 'thin',
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb) transparent',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface RawReplyViewProps {
	/** The text to show when open. */
	detail: string;
	/** Whether the text is shown. */
	open: boolean;
	/** Called when the toggle is pressed. */
	onToggle: () => void;
}

/**
 * The disclosure's markup for a given open state.
 *
 * @param props - {@link RawReplyViewProps}.
 * @returns The toggle and, when open, the text block.
 */
const RawReplyView: React.FC<RawReplyViewProps> = ({ detail, open, onToggle }) => (
	<div style={styles.root}>
		<button type="button" style={styles.toggle} onClick={onToggle} aria-expanded={open}>
			<span style={styles.chevron(open)} />
			Raw reply
		</button>
		{open && <pre style={styles.block}>{detail || '(empty reply)'}</pre>}
	</div>
);

/**
 * A closed-by-default disclosure for a status row's detail.
 *
 * @param props.detail - The text to show when the row is opened.
 * @returns The disclosure.
 */
export const RawReply: React.FC<{ detail: string }> = ({ detail }) => {
	const [open, setOpen] = useState(false);
	return <RawReplyView detail={detail} open={open} onToggle={() => setOpen((o) => !o)} />;
};
