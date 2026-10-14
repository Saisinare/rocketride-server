// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Runtime stand-in for the 'shell' / 'rocketride' platform specifiers, which
// only exist inside a running shell. The pure modules under test reach the
// platform through `import type` alone (erased by tsx); the few that import a
// value (for example the style fragments) get this stub instead.

const Module = require('module');

const stub = {
	// Any style-fragment lookup yields an empty, spreadable object.
	commonStyles: new Proxy({}, { get: () => ({}) }),
};

// Intercept CJS loads of the platform specifiers before tsx resolves them.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'shell' || request === 'rocketride') return stub;
	return origLoad.call(this, request, parent, isMain);
};
