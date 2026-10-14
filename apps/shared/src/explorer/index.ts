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
// EXPLORER — PUBLIC SURFACE (pure modules only)
// =============================================================================
//
// Import path for every app: 'shared/explorer' (or 'shared/explorer/<module>').
// Everything exported here is node:test-safe: no module in this barrel imports
// a VALUE from 'shell'. The two modules that do — shellBinding and react —
// are imported directly by the apps that mount them, never through here.
//
// The library is compiled into each app. It holds no module-level state: every
// store is made by a factory, and each app owns its own instances.
// =============================================================================

export type {
	EndpointState,
	IExplorerClient,
	IExplorerComponent,
	IExplorerEndpoint,
	IExplorerIdentity,
	IExplorerPipeline,
	IExplorerTaskRow,
	IProbeResult,
	IRoleBinding,
	IRoleDef,
	IRoleSpec,
} from './types';
export { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from './types';

export type { ExplorerErrorKind, IExplorerToolErrorInit } from './errors';
export { ExplorerToolError, isStaleError, readErrorCode, readErrorMessage, splitMessage } from './errors';

export type { CheckOutcome, ISchemaReading, ResultCheck, SchemaEvidence } from './checks';
export {
	checkGetQuery,
	checkLegacyErrorEnvelope,
	checkObject,
	checkRowEnvelope,
	checkStoreSuccess,
	checkValidFlag,
	classifySchemaV2,
	composeChecks,
	isPlainObject,
} from './checks';

export type { IGeneration, IGenerationTicket } from './generation';
export { createGeneration } from './generation';

export type { IEndpointKeyParts } from './keys';
export { KEY_VERSION, buildEndpointKey, encodeSegment, legacyKeyFromKey, parseEndpointKey, roleKeySource } from './keys';
