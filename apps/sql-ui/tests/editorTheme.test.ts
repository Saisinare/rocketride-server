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
// rgba(): a value it cannot read is drawn as red. Two shipped shell themes
// (RocketRide and RocketRide Light) declare --rr-text-secondary as rgba(),
// so passing that token straight through painted every inactive line number
// red (3.23:1 on RocketRide Light's paper). These tests read the real theme
// files and check the colours the editor would hand to Monaco, in all six.
//
// The same holds for SYNTAX colours: Monaco's own `vs` / `vs-dark` token
// colours were not chosen for these backgrounds. They are read here from the
// installed Monaco, and every SQL token class must reach 4.5:1 on the editor
// background in every shipped theme, through the rules the editor adds.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editorTheme, ensureContrast, monacoHex, parseCssColor } from '../src/components/editorTheme';
import type { IEditorTheme } from '../src/components/editorTheme';

/** An sRGB colour, 0-255 per channel. */
interface Rgb {
	r: number;
	g: number;
	b: number;
}

// An independent WCAG 2.x implementation, so these tests do not grade the helper with its own arithmetic.
function luminance({ r, g, b }: Rgb): number {
	const c = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
function ratio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))];
	return (hi + 0.05) / (lo + 0.05);
}
function rgbOf(hex: string): Rgb {
	assert.match(hex, /^#[0-9a-f]{6}$/i, `not #RRGGBB: ${hex}`);
	return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

const THEME_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'shell', 'public', 'themes');
const THEMES = fs
	.readdirSync(THEME_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => ({ name: f.replace(/\.json$/, ''), tokens: JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8')) as Record<string, string> }))
	.sort((a, b) => (a.name < b.name ? -1 : 1));
const reader = (tokens: Record<string, string>) => (name: string): string => tokens[name] ?? '';

const LINE_NUMBER_KEYS = ['editorLineNumber.foreground', 'editorLineNumber.activeForeground'] as const;

describe('shipped theme editor colours', () => {
	it('finds the six shipped themes', () => {
		assert.deepEqual(
			THEMES.map((t) => t.name),
			['dark', 'gray', 'light', 'rocketride', 'rocketride-light', 'visual-studio']
		);
	});

	it('every colour handed to Monaco is #RRGGBB, in every theme', () => {
		for (const { name, tokens } of THEMES) {
			const { colors } = editorTheme(reader(tokens));
			assert.deepEqual(Object.keys(colors).sort(), ['editor.background', 'editor.foreground', 'editorLineNumber.activeForeground', 'editorLineNumber.foreground']);
			for (const [key, value] of Object.entries(colors)) assert.match(value, /^#[0-9a-f]{6}$/i, `${name}: ${key} is ${JSON.stringify(value)}`);
		}
	});

	it('line numbers (inactive and active) reach 4.5:1 on the editor background, in every theme', () => {
		for (const { name, tokens } of THEMES) {
			const { colors } = editorTheme(reader(tokens));
			for (const key of LINE_NUMBER_KEYS) {
				const seen = ratio(rgbOf(colors[key]), rgbOf(colors['editor.background']));
				assert.ok(seen >= 4.5, `${name}: ${key} ${colors[key]} on ${colors['editor.background']} is ${seen.toFixed(2)}:1`);
			}
		}
	});

	it('an rgba() token is never drawn as red', () => {
		for (const { name, tokens } of THEMES) {
			const { colors } = editorTheme(reader(tokens));
			for (const key of LINE_NUMBER_KEYS) assert.notEqual(colors[key].toLowerCase(), '#ff0000', `${name}: ${key} came out red`);
		}
	});

	it('opaque tokens pass through unchanged, and the palette mode picks the Monaco base', () => {
		for (const { name, tokens } of THEMES) {
			const { colors, dark } = editorTheme(reader(tokens));
			assert.equal(colors['editor.background'], tokens['--rr-bg-paper'].toLowerCase(), `${name} background`);
			assert.equal(colors['editor.foreground'], tokens['--rr-text-primary'].toLowerCase(), `${name} foreground`);
			assert.equal(colors['editorLineNumber.activeForeground'], tokens['--rr-text-primary'].toLowerCase(), `${name} active line number`);
			assert.equal(dark, tokens['--rr-palette-mode'] === 'dark', `${name} dark`);
		}
	});

	it('a line-number colour that already reads is left exactly as the theme wrote it', () => {
		const expected: Record<string, string> = { dark: '#a8a8a8', gray: '#b4b4b4', light: '#666666', 'visual-studio': '#666666' };
		for (const { name, tokens } of THEMES) {
			if (!(name in expected)) continue;
			assert.equal(editorTheme(reader(tokens)).colors['editorLineNumber.foreground'], expected[name], name);
		}
	});

	it('RocketRide Light: rgba(10,10,10,0.62) is seen over the #e8e7e1 paper, not read as red', () => {
		const tokens = THEMES.find((t) => t.name === 'rocketride-light')!.tokens;
		assert.equal(tokens['--rr-text-secondary'], 'rgba(10,10,10,0.62)');
		assert.equal(editorTheme(reader(tokens)).colors['editorLineNumber.foreground'], '#5e5e5c');
	});

	it('RocketRide (dark): rgba(255,255,255,0.40) blends to #737373 (3.8:1) and is lightened to 4.5:1, staying neutral grey', () => {
		const tokens = THEMES.find((t) => t.name === 'rocketride')!.tokens;
		assert.equal(tokens['--rr-text-secondary'], 'rgba(255,255,255,0.40)');
		const lineNumber = rgbOf(editorTheme(reader(tokens)).colors['editorLineNumber.foreground']);
		assert.ok(lineNumber.r > 0x73, 'moved lighter than the blended colour');
		assert.ok(lineNumber.r === lineNumber.g && lineNumber.g === lineNumber.b, 'same hue and saturation: still grey');
	});
});

// =============================================================================
// SYNTAX COLOURS
// =============================================================================

/** Monaco's built-in token rules for one base theme, read from the installed package. */
function monacoBaseRules(base: 'vs' | 'vs-dark'): Map<string, string> {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'standalone', 'common', 'themes.js'), 'utf8');
	const block = new RegExp(`base: '${base}',[\\s\\S]*?rules: \\[([\\s\\S]*?)\\],\\s*colors`).exec(source);
	assert.ok(block, `Monaco's ${base} rules`);
	const rules = new Map<string, string>();
	for (const match of block[1]!.matchAll(/\{ token: '([^']*)', foreground: '([0-9a-fA-F]{6})'/g)) rules.set(match[1]!, match[2]!);
	return rules;
}

/** The token classes the sql, mysql and pgsql tokenizers emit (every one carries the `.sql` postfix). */
const SQL_TOKENS = [
	'keyword', 'keyword.try', 'keyword.catch', 'keyword.choice', 'keyword.block',
	'string', 'string.double', 'number', 'comment', 'comment.quote', 'operator', 'predefined',
	'delimiter', 'delimiter.parenthesis', 'delimiter.square', 'identifier', 'identifier.quote', 'white',
].map((token) => `${token}.sql`);

/**
 * The colour Monaco draws a token in: the most specific rule whose scope is a
 * prefix of the token (the theme's own rules over the base's), else the
 * editor foreground.
 *
 * @param token - The token class.
 * @param theme - The editor theme.
 * @returns `#rrggbb`.
 */
function drawnColour(token: string, theme: IEditorTheme): string {
	const rules = monacoBaseRules(theme.dark ? 'vs-dark' : 'vs');
	for (const rule of theme.rules) rules.set(rule.token, rule.foreground);
	const parts = token.split('.');
	for (let i = parts.length; i > 0; i--) {
		const hit = rules.get(parts.slice(0, i).join('.'));
		if (hit !== undefined) return `#${hit.toLowerCase()}`;
	}
	return theme.colors['editor.foreground'];
}

describe('SQL syntax colours', () => {
	it('every SQL token reaches 4.5:1 on the editor background, in every shipped theme', () => {
		const failures: string[] = [];
		for (const { name, tokens } of THEMES) {
			const theme = editorTheme(reader(tokens));
			const background = rgbOf(theme.colors['editor.background']);
			for (const token of SQL_TOKENS) {
				const colour = drawnColour(token, theme);
				const seen = ratio(rgbOf(colour), background);
				if (seen < 4.5) failures.push(`${name}: ${token} ${colour} on ${theme.colors['editor.background']} is ${seen.toFixed(2)}:1`);
			}
		}
		assert.deepEqual(failures, []);
	});

	it('adds a rule only for a token whose Monaco colour fails, and writes it as Monaco reads it', () => {
		for (const { name, tokens } of THEMES) {
			const theme = editorTheme(reader(tokens));
			const base = monacoBaseRules(theme.dark ? 'vs-dark' : 'vs');
			const background = rgbOf(theme.colors['editor.background']);
			for (const rule of theme.rules) {
				assert.match(rule.foreground, /^[0-9A-F]{6}$/, `${name}: ${rule.token}`);
				const original = base.get(rule.token);
				assert.ok(original !== undefined, `${name}: ${rule.token} is not one of Monaco's own rules`);
				assert.ok(ratio(rgbOf(`#${original}`), background) < 4.5, `${name}: ${rule.token} already read at ${original}`);
			}
		}
	});

	it('RocketRide Light: operators, strings, numbers and comments are the ones moved', () => {
		const theme = editorTheme(reader(THEMES.find((t) => t.name === 'rocketride-light')!.tokens));
		const moved = theme.rules.map((rule) => rule.token);
		for (const token of ['operator.sql', 'string.sql', 'number', 'comment']) assert.ok(moved.includes(token), `${token} not moved (${moved.join(', ')})`);
		assert.ok(!moved.includes('keyword'), 'a keyword colour that already reads is left as Monaco draws it');
	});
});

describe('editor colours without usable tokens', () => {
	it('unset tokens fall back to hex, and the fallback line numbers still read', () => {
		for (const mode of ['light', 'dark']) {
			const { colors, dark } = editorTheme((name) => (name === '--rr-palette-mode' ? mode : ''));
			assert.equal(dark, mode === 'dark');
			assert.equal(colors['editor.background'], mode === 'dark' ? '#252526' : '#ffffff');
			assert.equal(colors['editor.foreground'], mode === 'dark' ? '#cccccc' : '#1a1a1a');
			for (const key of LINE_NUMBER_KEYS) assert.ok(ratio(rgbOf(colors[key]), rgbOf(colors['editor.background'])) >= 4.5, `${mode} ${key}`);
		}
	});

	it('tokens that are not colours (var(), names, keywords) use the fallback', () => {
		const { colors } = editorTheme((name) => ({ '--rr-bg-paper': 'var(--elsewhere)', '--rr-text-primary': 'currentcolor', '--rr-text-secondary': 'not a colour', '--rr-palette-mode': '"light"' })[name] ?? '');
		assert.equal(colors['editor.background'], '#ffffff');
		assert.equal(colors['editor.foreground'], '#1a1a1a');
		assert.match(colors['editorLineNumber.foreground'], /^#[0-9a-f]{6}$/i);
	});

	it('a translucent background is blended over the fallback paper, not left as rgba()', () => {
		const { colors } = editorTheme((name) => ({ '--rr-bg-paper': 'rgba(0,0,0,0.5)', '--rr-palette-mode': 'light' })[name] ?? '');
		assert.equal(colors['editor.background'], '#808080');
	});
});

describe('parseCssColor', () => {
	it('reads hex in 3, 4, 6 and 8 digits', () => {
		assert.deepEqual(parseCssColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
		assert.deepEqual(parseCssColor('#112233'), { r: 0x11, g: 0x22, b: 0x33, a: 1 });
		assert.deepEqual(parseCssColor('#11223380'), { r: 0x11, g: 0x22, b: 0x33, a: 128 / 255 });
		assert.deepEqual(parseCssColor('#0008'), { r: 0, g: 0, b: 0, a: 0x88 / 255 });
	});

	it('reads rgb()/rgba() with commas, spaces, a slash alpha, percentages and decimals', () => {
		assert.deepEqual(parseCssColor('rgba(10,10,10,0.62)'), { r: 10, g: 10, b: 10, a: 0.62 });
		assert.deepEqual(parseCssColor('rgb(255 0 0 / 50%)'), { r: 255, g: 0, b: 0, a: 0.5 });
		assert.deepEqual(parseCssColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0, a: 1 });
		assert.deepEqual(parseCssColor('RGBA( 1.5 , 2 , 3 , .25 )'), { r: 2, g: 2, b: 3, a: 0.25 });
		assert.deepEqual(parseCssColor('rgb(300, -4, 0)'), { r: 255, g: 0, b: 0, a: 1 });
	});

	it('reads hsl()/hsla()', () => {
		assert.deepEqual(parseCssColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
		assert.deepEqual(parseCssColor('hsla(120, 100%, 25%, 0.5)'), { r: 0, g: 128, b: 0, a: 0.5 });
	});

	it('returns null for anything else', () => {
		for (const text of ['', ' ', 'red', 'transparent', 'currentcolor', 'var(--x)', '#12', '#12345', '#gggggg', 'rgb(1,2)', 'color-mix(in srgb, red, blue)']) assert.equal(parseCssColor(text), null, JSON.stringify(text));
	});
});

describe('monacoHex', () => {
	const white = { r: 255, g: 255, b: 255 };
	it('writes an opaque colour as #rrggbb', () => {
		assert.equal(monacoHex('#ABC', white, '#000000'), '#aabbcc');
		assert.equal(monacoHex('rgb(1, 2, 3)', white, '#000000'), '#010203');
	});
	it('blends a translucent colour over the background', () => {
		assert.equal(monacoHex('rgba(0,0,0,0.5)', white, '#000000'), '#808080');
		assert.equal(monacoHex('rgba(255,255,255,0.4)', { r: 22, g: 22, b: 22 }, '#000000'), '#737373');
		assert.equal(monacoHex('#00000000', { r: 9, g: 8, b: 7 }, '#000000'), '#090807');
	});
	it('uses the fallback when the text is not a colour', () => {
		assert.equal(monacoHex('var(--x)', white, '#123456'), '#123456');
		assert.equal(monacoHex('', white, '#123456'), '#123456');
	});
});

describe('ensureContrast', () => {
	const dark = { r: 22, g: 22, b: 22 };
	const light = { r: 232, g: 231, b: 225 };

	it('returns a colour that already reads untouched', () => {
		const grey = { r: 0x66, g: 0x66, b: 0x66 };
		assert.equal(ensureContrast(grey, { r: 255, g: 255, b: 255 }, 4.5), grey);
	});

	it('lightens on a dark background and darkens on a light one until the ratio is reached', () => {
		const onDark = ensureContrast({ r: 0x73, g: 0x73, b: 0x73 }, dark, 4.5);
		assert.ok(onDark.r > 0x73 && ratio(onDark, dark) >= 4.5);
		const onLight = ensureContrast({ r: 0x90, g: 0x90, b: 0x90 }, light, 4.5);
		assert.ok(onLight.r < 0x90 && ratio(onLight, light) >= 4.5);
	});

	it('keeps a coloured input on its own hue while it moves', () => {
		const out = ensureContrast({ r: 0x3a, g: 0x6e, b: 0xa5 }, dark, 4.5);
		assert.ok(ratio(out, dark) >= 4.5);
		assert.ok(out.b > out.g && out.g > out.r, 'still blue-leaning, same order of channels');
	});

	it('reaches the ratio on a mid-grey background by going to the better end', () => {
		const mid = { r: 0x77, g: 0x77, b: 0x77 };
		for (const start of [{ r: 0x70, g: 0x70, b: 0x70 }, { r: 0x80, g: 0x80, b: 0x80 }]) assert.ok(ratio(ensureContrast(start, mid, 4.5), mid) >= 4.5);
	});
});

describe('SqlEditor wiring', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'SqlEditor.tsx'), 'utf8');

	it('registers the theme from editorTheme(), not from raw token strings', () => {
		assert.match(source, /from '\.\/editorTheme'/);
		assert.match(source, /editorTheme\(/);
		assert.ok(!/'editor(Line)?[A-Za-z.]*':\s*cssVar\(/.test(source), 'a Monaco colour is still taken straight from cssVar()');
	});

	it('hands editorTheme()\'s token rules to Monaco instead of an empty list', () => {
		assert.ok(!/rules:\s*\[\]/.test(source), 'the theme still registers no token rules');
		assert.match(source, /rules:\s*\[\.\.\.rules\]|rules,|rules:\s*rules/);
	});

	it('no longer claims every shipped theme uses plain hex', () => {
		assert.ok(!/plain hex in every shipped theme/.test(source));
	});
});
