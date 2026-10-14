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
// SQL EDITOR THEME — Monaco colours derived from the shell's --rr-* tokens
// =============================================================================
//
// Monaco takes theme colours as #RRGGBB (or #RRGGBBAA). It does not parse
// rgba(): a value it cannot read is drawn as red. The shell's tokens are CSS,
// and two shipped themes (RocketRide and RocketRide Light) declare
// --rr-text-secondary as rgba(), so handing the token over as written painted
// every inactive line number red (3.23:1 on RocketRide Light's paper).
//
// Every colour the editor gives Monaco therefore goes through here:
//   - a translucent token is blended over the editor background (which is how
//     it is seen), and the result written as #rrggbb;
//   - a token that is not a colour at all (var(), a keyword, empty) falls back
//     to a plain hex;
//   - line numbers that would still read under 4.5:1 (WCAG 1.4.3, small text)
//     are moved along their own lightness until they do;
//   - SYNTAX colours too: Monaco colours SQL with its built-in `vs` / `vs-dark`
//     palettes, which were not chosen for these backgrounds (on RocketRide
//     Light's #e8e7e1, operators are 2.94:1 and strings 3.23:1). Each token
//     class keeps Monaco's colour when it already reaches 4.5:1 on the editor
//     background, and otherwise gets a rule moving it along its own lightness
//     (same hue, same saturation) until it does. No colour is written per theme.
//
// Pure: it takes a token reader rather than touching the DOM or Monaco, so a
// test can build the colours for every shipped theme and measure them.
// (Apps do not import each other, so another Explorer app that needs the
// same job keeps its own copy of this logic.)
// =============================================================================

/** Text contrast the line numbers and syntax colours must reach (WCAG 1.4.3). */
export const LINE_NUMBER_MIN_CONTRAST = 4.5;

/** A Monaco token rule; `foreground` is `RRGGBB` (no `#`), the form Monaco's rules take. */
export interface ITokenRule {
	token: string;
	foreground: string;
}

/**
 * The token classes Monaco's sql, mysql and pgsql tokenizers produce that its
 * own `vs` / `vs-dark` themes colour, with those colours
 * (monaco-editor/esm/vs/editor/standalone/common/themes.js). Every SQL token
 * carries the `.sql` postfix, and a rule colours every token it is a prefix of:
 * `comment` also colours `comment.quote.sql`, and `string` colours MySQL's
 * `string.double.sql`. Identifiers and whitespace have no entry: they are drawn
 * in the editor's foreground, which is already held to the same contrast.
 */
export const SQL_TOKEN_BASES: ReadonlyArray<{ token: string; light: string; dark: string }> = [
	{ token: 'keyword', light: '0000FF', dark: '569CD6' },
	{ token: 'string', light: 'A31515', dark: 'CE9178' },
	{ token: 'string.sql', light: 'FF0000', dark: 'FF0000' },
	{ token: 'number', light: '098658', dark: 'B5CEA8' },
	{ token: 'comment', light: '008000', dark: '608B4E' },
	{ token: 'operator.sql', light: '778899', dark: '778899' },
	{ token: 'predefined.sql', light: 'C700C7', dark: 'FF00FF' },
	{ token: 'delimiter', light: '000000', dark: 'DCDCDC' },
];

/** An opaque sRGB colour, 0-255 per channel. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** A parsed CSS colour: channels 0-255 and alpha 0-1. */
export interface Rgba extends Rgb {
	a: number;
}

/** Reads a CSS custom property by name ('' when unset). */
export type TokenReader = (name: string) => string;

/** The Monaco colour keys the editor sets; every value is #RRGGBB. */
export interface IEditorColors {
	'editor.background': string;
	'editor.foreground': string;
	'editorLineNumber.foreground': string;
	'editorLineNumber.activeForeground': string;
}

/** The editor theme: Monaco's base palette, its colours and the token rules it adds. */
export interface IEditorTheme {
	dark: boolean;
	colors: IEditorColors;
	/** Rules only for the token classes whose Monaco colour does not reach 4.5:1 (empty when all do). */
	rules: ITokenRule[];
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** `12.5%` or `12.5` as a number, with a percentage scaled to `full`. */
function scaled(text: string, full: number): number {
	return text.endsWith('%') ? (parseFloat(text) / 100) * full : parseFloat(text);
}

/**
 * HSL to RGB.
 *
 * @param h - Hue in degrees.
 * @param s - Saturation 0-1.
 * @param l - Lightness 0-1.
 * @returns The colour.
 */
function hslToRgb(h: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

/** RGB to hue (degrees), saturation and lightness (0-1). */
function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return { h: h * 60, s, l };
}

/**
 * Parse a CSS colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`
 * (commas or spaces, an optional `/ alpha`, percentages) and `hsl()`/`hsla()`.
 * Anything else (`var()`, names, `color-mix()`, empty text) is not a colour here.
 *
 * @param text - A CSS colour.
 * @returns The colour with its alpha, or null.
 */
export function parseCssColor(text: string): Rgba | null {
	const value = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
	if (hex) {
		const digits = hex[1].length <= 4 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
		const byte = (i: number): number => parseInt(digits.slice(i, i + 2), 16);
		return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
	}
	const number = '(-?\\d*\\.?\\d+%?)';
	const rgb = new RegExp(`^rgba?\\(\\s*${number}\\s*[,\\s]\\s*${number}\\s*[,\\s]\\s*${number}\\s*(?:[,/]\\s*${number}\\s*)?\\)$`).exec(value);
	if (rgb) {
		return {
			r: Math.round(clamp(scaled(rgb[1], 255), 0, 255)),
			g: Math.round(clamp(scaled(rgb[2], 255), 0, 255)),
			b: Math.round(clamp(scaled(rgb[3], 255), 0, 255)),
			a: rgb[4] === undefined ? 1 : clamp(scaled(rgb[4], 1), 0, 1),
		};
	}
	const hsl = new RegExp(`^hsla?\\(\\s*(-?\\d*\\.?\\d+)(?:deg)?\\s*[,\\s]\\s*(\\d*\\.?\\d+)%\\s*[,\\s]\\s*(\\d*\\.?\\d+)%\\s*(?:[,/]\\s*${number}\\s*)?\\)$`).exec(value);
	if (hsl) return { ...hslToRgb(parseFloat(hsl[1]), clamp(parseFloat(hsl[2]) / 100, 0, 1), clamp(parseFloat(hsl[3]) / 100, 0, 1)), a: hsl[4] === undefined ? 1 : clamp(scaled(hsl[4], 1), 0, 1) };
	return null;
}

/** The colour as it is seen: `color` blended over `background` by its alpha. */
function over(color: Rgba, background: Rgb): Rgb {
	const mix = (c: number, b: number): number => Math.round(color.a * c + (1 - color.a) * b);
	return { r: mix(color.r, background.r), g: mix(color.g, background.g), b: mix(color.b, background.b) };
}

/**
 * An opaque `#rrggbb`, the only form Monaco reads reliably.
 *
 * @param css - The token's CSS colour.
 * @param background - What it is drawn on (a translucent colour is blended over it).
 * @param fallback - Plain hex used when `css` is not a colour.
 * @returns `#rrggbb`.
 */
export function monacoHex(css: string, background: Rgb, fallback: string): string {
	const parsed = parseCssColor(css) ?? (parseCssColor(fallback) as Rgba);
	return toHex(over(parsed, background));
}

/** `#rrggbb`, lower case. */
function toHex({ r, g, b }: Rgb): string {
	const part = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
	const channel = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour itself when it already reaches `minimum` against the background,
 * otherwise the nearest colour of the same hue and saturation that does
 * (lightness moved away from the background, towards whichever end reads best).
 *
 * @param color - The colour.
 * @param background - The background it is drawn on.
 * @param minimum - The contrast to reach.
 * @returns `color` itself, or a new colour.
 */
export function ensureContrast(color: Rgb, background: Rgb, minimum: number = LINE_NUMBER_MIN_CONTRAST): Rgb {
	if (contrast(color, background) >= minimum) return color;
	const { h, s, l } = toHsl(color);
	const towardWhite = contrast({ r: 255, g: 255, b: 255 }, background) > contrast({ r: 0, g: 0, b: 0 }, background);
	let near = l;
	let far = towardWhite ? 1 : 0;
	// The better of black and white always reaches 4.5:1 (the best possible ratio on any background is at least 4.58).
	if (contrast(hslToRgb(h, s, far), background) < minimum) return color;
	// Bisect for the lightness closest to the colour's own that still reaches the ratio.
	for (let i = 0; i < 24; i++) {
		const mid = (near + far) / 2;
		if (contrast(hslToRgb(h, s, mid), background) >= minimum) far = mid;
		else near = mid;
	}
	return hslToRgb(h, s, far);
}

/**
 * The token rules for a palette and an editor background: a rule only for a
 * token class whose Monaco colour does not reach 4.5:1, moved along its own
 * lightness until it does.
 *
 * @param dark - Whether the palette is dark (Monaco's `vs-dark` base).
 * @param background - The editor's background, opaque.
 * @returns Rules for the failing token classes.
 */
export function sqlTokenRules(dark: boolean, background: Rgb): ITokenRule[] {
	const rules: ITokenRule[] = [];
	for (const { token, light, dark: darkBase } of SQL_TOKEN_BASES) {
		const base = parseCssColor(`#${dark ? darkBase : light}`) as Rgba;
		const adjusted = ensureContrast(base, background);
		if (adjusted !== base) rules.push({ token, foreground: toHex(adjusted).slice(1).toUpperCase() });
	}
	return rules;
}

/**
 * The editor's Monaco theme from the shell's tokens.
 *
 * @param read - Reads a --rr-* custom property ('' when unset).
 * @returns Whether the palette is dark, four #rrggbb colours and the token rules.
 */
export function editorTheme(read: TokenReader): IEditorTheme {
	const token = (name: string): string => read(name).trim();
	const dark = token('--rr-palette-mode').replace(/['"]/g, '') === 'dark';
	const fallbackBackground = dark ? '#252526' : '#ffffff';
	const fallbackForeground = dark ? '#cccccc' : '#1a1a1a';

	// The background is what everything else is blended over; a translucent one is blended over the fallback paper.
	const paper = parseCssColor(fallbackBackground) as Rgba;
	const backgroundHex = monacoHex(token('--rr-bg-paper'), paper, fallbackBackground);
	const background = parseCssColor(backgroundHex) as Rgba;

	/** A text colour as seen on the editor background, brought up to the line-number contrast when it falls short. */
	const lineNumber = (name: string, fallback: string): string => {
		const seen = parseCssColor(monacoHex(token(name), background, fallback)) as Rgba;
		return toHex(ensureContrast(seen, background));
	};

	return {
		dark,
		colors: {
			'editor.background': backgroundHex,
			'editor.foreground': monacoHex(token('--rr-text-primary'), background, fallbackForeground),
			// The line-number fallback is the old '#666666' (it is moved if it does not read on a dark paper).
			'editorLineNumber.foreground': lineNumber('--rr-text-secondary', '#666666'),
			'editorLineNumber.activeForeground': lineNumber('--rr-text-primary', '#1a1a1a'),
		},
		rules: sqlTokenRules(dark, background),
	};
}
