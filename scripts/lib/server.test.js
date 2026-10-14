/**
 * Tests for the test-server log file: the complete record of what a test server
 * printed, kept so CI can upload it when a test run fails.
 *
 * No test runner is wired into this repo's build scripts yet, so this uses the
 * zero-dependency built-in runner. Run:
 *     node --test scripts/lib/server.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { finished } = require('node:stream/promises');

const { BUILD_ROOT } = require('./paths');
const { testServerLogFile, openServerLog } = require('./server');

/**
 * Create a fresh, empty temp directory for a single test case.
 * @returns {string} Absolute path to the new directory
 */
function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-server-test-'));
}

test('testServerLogFile: one file per suite under the build tree', () => {
	assert.strictEqual(
		testServerLogFile('client-typescript'),
		path.join(BUILD_ROOT, 'test-logs', 'client-typescript-server.log')
	);
	assert.notStrictEqual(testServerLogFile('nodes'), testServerLogFile('client-python'));
});

test('openServerLog: creates missing directories and keeps every chunk in order', async () => {
	const logFile = path.join(tmpDir(), 'a', 'b', 'server.log');

	const stream = openServerLog(logFile);
	stream.write(Buffer.from('stdout line\n'));
	stream.write(Buffer.from('stderr line\n'));
	stream.end();
	await finished(stream);

	assert.strictEqual(fs.readFileSync(logFile, 'utf8'), 'stdout line\nstderr line\n');
});

test('openServerLog: reports a log it cannot set up and returns null instead of throwing', (t) => {
	const blocker = path.join(tmpDir(), 'not-a-directory');
	fs.writeFileSync(blocker, '');
	const errors = t.mock.method(console, 'error', () => {});

	const stream = openServerLog(path.join(blocker, 'logs', 'server.log'));

	assert.strictEqual(stream, null);
	assert.strictEqual(errors.mock.callCount(), 1);
	assert.match(errors.mock.calls[0].arguments[0], /cannot write/);
});

test('openServerLog: replaces the log of an earlier run', async () => {
	const logFile = path.join(tmpDir(), 'server.log');
	fs.writeFileSync(logFile, 'earlier run, longer than the new one\n');

	const stream = openServerLog(logFile);
	stream.end('new run\n');
	await finished(stream);

	assert.strictEqual(fs.readFileSync(logFile, 'utf8'), 'new run\n');
});
