/**
 * Tests for the test-server log: everything a test server prints, kept in
 * build/test-logs/ so CI can upload it when a test run fails.
 *
 * A small node script stands in for the engine through startServer's `command`
 * option. No test runner is wired into this repo's build scripts yet, so this
 * uses the zero-dependency built-in runner. Run:
 *     node --test scripts/lib/server.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { BUILD_ROOT } = require('./paths');
const { startServer, stopServer } = require('./server');

// Reports ready the way Uvicorn does, keeps printing on both streams, and says
// goodbye only when stdin closes, as the engine does under --autoterm.
const FAKE_SERVER = `
const server = require('net').createServer().listen(0, '127.0.0.1', () => {
	console.log('Uvicorn running on http://127.0.0.1:' + server.address().port);
	console.log('Application startup complete.');
	console.log('after ready on stdout');
	console.error('after ready on stderr');
});
process.stdin.on('end', () => {
	console.log('stdin closed - goodbye');
	server.close();
});
process.stdin.resume();
`;

/**
 * Start the fake server with a log name unique to this test run.
 * @param {import('node:test').TestContext} t - Removes the log file afterwards
 * @param {object} options - Extra startServer options
 * @returns {Promise<{server: object, diagnostics: object, logFile: string}>}
 */
async function startFakeServer(t, options) {
	const logName = `server-test-${process.pid}-${Date.now()}`;
	const logFile = path.join(BUILD_ROOT, 'test-logs', `${logName}-server.log`);
	t.after(() => fs.rmSync(logFile, { force: true }));

	const { server, diagnostics } = await startServer({
		script: 'fake-server',
		command: [process.execPath, '-e', FAKE_SERVER],
		logName,
		...options,
	});
	return { server, diagnostics, logFile };
}

test('startServer: the log holds everything the server printed until it exited', async (t) => {
	const { server, diagnostics, logFile } = await startFakeServer(t, { verbose: true });

	await stopServer({ server });

	const log = fs.readFileSync(logFile, 'utf8');
	assert.match(log, /after ready on stdout/);
	assert.match(log, /after ready on stderr/);
	assert.match(log, /stdin closed - goodbye/);
	assert.strictEqual(diagnostics.logFile, logFile);
	const closed = await Promise.race([
		diagnostics.logDone.then(() => true),
		new Promise((resolve) => setImmediate(() => resolve(false))),
	]);
	assert.ok(closed, 'the log file is still open after the server stopped');
});

test('startServer: without --verbose and outside CI there is no log file', async (t) => {
	const ci = process.env.CI;
	delete process.env.CI;
	t.after(() => {
		if (ci !== undefined) process.env.CI = ci;
	});

	const { server, diagnostics, logFile } = await startFakeServer(t, {});

	await stopServer({ server });

	assert.strictEqual(diagnostics.logFile, null);
	assert.ok(!fs.existsSync(logFile));
});
