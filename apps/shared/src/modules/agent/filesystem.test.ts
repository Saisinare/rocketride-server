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
// FILESYSTEM TOOLS TESTS — read before edit, no overwriting unsaved editor changes, read-only guides
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FilesystemTools } from './filesystem';
import { GuideFileSystem } from './guides';
import type { MemoryWorkspace } from './testing/memoryWorkspace';
import { createMemoryWorkspace } from './testing/memoryWorkspace';

// =============================================================================
// HELPERS
// =============================================================================

/** One toolkit per workspace, so reads carry over between calls the way they do within one run. */
const toolkits = new WeakMap<MemoryWorkspace, FilesystemTools>();

/**
 * Runs one filesystem tool by name against a workspace. Calls on the same
 * workspace share one toolkit, as the tools of one agent run do.
 *
 * @param ws - The workspace the tools work on.
 * @param tool - The tool name the model would call.
 * @param args - The tool arguments.
 * @returns The tool result text.
 */
function run(ws: MemoryWorkspace, tool: string, args: Record<string, unknown>): Promise<string> {
	if (!toolkits.has(ws)) toolkits.set(ws, new FilesystemTools(ws));
	const found = toolkits
		.get(ws)
		?.tools()
		.find((t) => t.name === tool);
	if (!found) throw new Error(`No such tool: ${tool}`);
	return found.execute(args);
}

// =============================================================================
// READ BEFORE EDIT
// =============================================================================

test('edit_file and write_file refuse a file not read, or changed since it was read', async () => {
	const edit = { path: 'a.ts', oldString: 'a', newString: 'b' };
	const write = { path: 'a.ts', content: 'new' };
	const rows: Array<[name: string, tool: string, args: Record<string, unknown>, changed: boolean, message: RegExp]> = [
		['edit, unread', 'edit_file', edit, false, /^Error: edit_file refused: read a\.ts first — edits must start from its current content\.$/],
		['write, unread', 'write_file', write, false, /^Error: write_file refused: read a\.ts first — edits must start from its current content\.$/],
		['edit, changed since read', 'edit_file', edit, true, /^Error: edit_file refused: a\.ts changed since you read it\. Read it again, then redo the edit\.$/],
		['write, changed since read', 'write_file', write, true, /^Error: write_file refused: a\.ts changed since you read it\. Read it again, then redo the edit\.$/],
	];
	for (const [name, tool, args, changed, message] of rows) {
		const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
		if (changed) {
			await run(ws, 'read_file', { path: 'a.ts' });
			ws.files.set('a.ts', 'a = 2');
		}
		await assert.rejects(run(ws, tool, args), message, name);
		assert.equal(ws.files.get('a.ts'), changed ? 'a = 2' : 'a = 1', `${name}: file unchanged`);
		assert.deepEqual(ws.log, [], `${name}: nothing written`);
	}
});

test('a changed file can be edited after it is read again', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	await run(ws, 'read_file', { path: 'a.ts' });
	ws.files.set('a.ts', 'a = 2');
	await run(ws, 'read_file', { path: 'a.ts' });
	await run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' });
	assert.equal(ws.files.get('a.ts'), 'b = 2');
});

// =============================================================================
// UNSAVED EDITOR CHANGES
// =============================================================================

test('edit_file and write_file refuse a dirty file, even after reading it', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' }, { dirty: ['a.ts'] });
	await run(ws, 'read_file', { path: 'a.ts' });
	await assert.rejects(run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' }), /edit_file refused: a\.ts has unsaved editor changes/);
	await assert.rejects(run(ws, 'write_file', { path: 'a.ts', content: 'b' }), /write_file refused: a\.ts has unsaved editor changes/);
	assert.deepEqual(ws.log, []);
	assert.equal(ws.files.get('a.ts'), 'a = 1');
});

// =============================================================================
// GUIDES — the agent reads guides at .rocketride/ but cannot change them
// =============================================================================

test('the file tools read guides but cannot change them', async () => {
	const base = createMemoryWorkspace({ 'apps/a.ts': 'const a = 1;\n' });
	const guides = { paths: () => ['docs/ROCKETRIDE_APPS.md'], read: async () => '# Apps\nBuild apps here.\n' };
	const tools = new Map(new FilesystemTools(new GuideFileSystem(base, guides)).tools().map((t) => [t.name, t]));
	const run = (name: string, args: Record<string, unknown>) => (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(args);
	const guide = '.rocketride/docs/ROCKETRIDE_APPS.md';
	const readOnly = /Guides under \.rocketride\/ are read-only\./;

	assert.match(await run('read_file', { path: guide }), /Build apps here\./);
	await assert.rejects(run('write_file', { path: guide, content: 'x' }), readOnly);
	await assert.rejects(run('edit_file', { path: guide, oldString: 'Apps', newString: 'Mine' }), readOnly);
	await assert.rejects(run('delete_file', { path: guide }), readOnly);
	await assert.rejects(run('rename', { oldPath: guide, newPath: 'a.md' }), readOnly);
	await assert.rejects(run('write_file', { path: '.rocketride/notes.md', content: 'x' }), readOnly);
	await assert.rejects(run('create_directory', { path: '.rocketride/mine' }), readOnly);
	assert.deepEqual(base.log, [], 'nothing reached the workspace');
});
