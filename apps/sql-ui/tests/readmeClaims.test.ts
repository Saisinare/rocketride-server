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
// README CLAIMS — what the Connections page says a card click does
// =============================================================================
//
// The shared landing opens a card's workbench on click and puts the probe
// drawer behind the card's Edit action and the add tile. The README told users
// a click opened the drawer, so they could "probe before binding"; a click in
// fact binds at once. This pins the README to the wiring, so the two cannot
// drift apart again without a test failing.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
const landing = fs.readFileSync(path.resolve(__dirname, '..', '..', 'shared', 'src', 'explorer', 'components', 'ConnectionsLanding.tsx'), 'utf8');

describe('README: a connection card click', () => {
	it('is wired to open the workbench, with the drawer behind Edit and the add tile', () => {
		assert.match(landing, /onClick=\{\(\) => onOpen\(endpoint\)\}/);
		assert.match(landing, /onEdit=\{\(\) => openDrawer\(endpoint\)\}/);
		assert.match(landing, /<ConnectionCardAdd [^>]*onClick=\{\(\) => openDrawer\(null\)\}/);
	});

	it('is described the way it is wired', () => {
		assert.doesNotMatch(readme, /selecting one opens a drawer/i);
		assert.match(readme, /Selecting a card opens its workbench/);
		assert.match(readme, /\*\*Edit\*\* action/);
	});
});
