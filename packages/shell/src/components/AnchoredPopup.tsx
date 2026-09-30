// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AnchoredPopup — the positioning container for any anchored popup or menu.
 *
 * Renders its children into the host's popup portal (`#rr-popup-portal`,
 * falling back to document.body) at a fixed, measured position beside the
 * anchor — escaping every overflow:hidden ancestor — flipped to the other
 * side when the preferred one lacks room and clamped into the viewport
 * (useFixedPopupPosition's measured mode). Repositions on scroll/resize.
 *
 * Dismissal: mousedown outside, or Escape. Mousedowns inside the ANCHOR are
 * ignored so the trigger's own onClick toggle closes the popup instead of
 * close-then-reopen racing it.
 *
 * Purely positional — the visual chrome (background, border, shadow) comes
 * from `style` and the children, so PopupRow bodies and bespoke menus
 * compose unchanged.
 */

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFixedPopupPosition } from '../hooks/useFixedPopupPosition';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// The positioned box — coordinates and visibility are merged in at render.
	popup: {
		position: 'fixed',
		zIndex: 1000,
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface AnchoredPopupProps {
	/** The trigger element the popup positions against. */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** Whether the popup is open (closed renders nothing). */
	open: boolean;
	/** Dismissal callback (outside mousedown, Escape). */
	onClose: () => void;
	/** Preferred side of the anchor (default 'below'; flips when out of room). */
	placement?: 'below' | 'above';
	/** Horizontal alignment against the anchor (default 'start'). */
	align?: 'start' | 'end';
	/** Gap between anchor and popup in px (default 4). */
	gap?: number;
	/** Match the popup's width to the anchor's (split buttons, comboboxes). */
	matchAnchorWidth?: boolean;
	/** Visual chrome for the popup box (merged over the positional base). */
	style?: React.CSSProperties;
	children?: React.ReactNode;
}

export const AnchoredPopup: React.FC<AnchoredPopupProps> = ({ anchorRef, open, onClose, placement = 'below', align = 'start', gap = 4, matchAnchorWidth = false, style, children }) => {
	const popupRef = useRef<HTMLDivElement>(null);
	const pos = useFixedPopupPosition(anchorRef, open, placement, { popupRef, align, gap, matchWidth: matchAnchorWidth });

	// step: dismissal — outside mousedown and Escape while open
	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (popupRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('mousedown', onMouseDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onMouseDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open, onClose, anchorRef]);

	if (!open) return null;

	// step: the host's portal root when present (looked up per render — a
	// cached node can go stale under React 18 concurrent re-invocation)
	const container = document.getElementById('rr-popup-portal') ?? document.body;

	// step: render hidden until measured — the box must exist to be measured,
	// and the measurement runs pre-paint so the hidden frame never shows
	return createPortal(
		<div ref={popupRef} style={{ ...styles.popup, ...style, top: pos?.top ?? 0, left: pos?.left ?? 0, ...(pos?.width != null ? { width: pos.width } : null), visibility: pos ? 'visible' : 'hidden' }}>
			{children}
		</div>,
		container,
	);
};
