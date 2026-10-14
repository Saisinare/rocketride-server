# Explorer library (`apps/shared/src/explorer/`)

The code every Explorer app shares: finding tool nodes in running pipelines,
calling them safely, keeping per-connection history, and running a batch of
statements honestly. SQL Explorer (`apps/sql-ui`) is the reference consumer;
read its `src/connect/`, `src/history/` and `src/views/QueryView.tsx` next to
this page. This page is for people changing the library or adding an Explorer;
what each app does for its users is documented in that app's own folder.

## Rules that shape everything

- **Factories, not singletons.** Nothing under `explorer/` holds module-level
  state. `createEndpointStore`, `createHistoryStore`, `createAnnouncer`,
  `createActiveKeyStore` and the rest return instances; each app creates and
  owns its own. The library is **compiled into each app** (source, not a
  Module Federation module), so two Explorers never share a store, a timer or a
  token.
- **Import path.** `shared/explorer` is the barrel of the pure modules;
  everything else is `shared/explorer/<module>` (for example
  `shared/explorer/connect/store`). It resolves through the app's `tsconfig`
  `paths` entry `shared/*`, like the other `shared/...` imports.
- **Only three places may import a *value* from `shell`:**
  [`shellBinding.ts`](../../../apps/shared/src/explorer/shellBinding.ts),
  [`react.tsx`](../../../apps/shared/src/explorer/react.tsx) and
  [`components/`](../../../apps/shared/src/explorer/components/). Every other
  module (and the barrel) is pure, so its tests run under `node:test` without
  the shell. Components and `react.tsx` are not exported from the barrel; import
  them by path.
- **Task tokens are secrets.** See [Tokens](#tokens-and-identity).
- **No Node-only globals outside `*.test.ts(x)`.** `shell:freeze` (and so
  `./builder shell:check`) type-checks `apps/shared/src` with the browser libs
  and **without Node types**, so a helper such as
  [`connect/testing.ts`](../../../apps/shared/src/explorer/connect/testing.ts)
  must not use `setImmediate`, `process`, `Buffer` or `require`. `shared:test`
  adds Node types for the test files only (`tsconfig.test.json`), so it can pass
  while `shell:check` fails: run both.

## Discovery

[`connect/discovery.ts`](../../../apps/shared/src/explorer/connect/discovery.ts)
reads `client.getTasks()`: the **running** tasks the caller may see, each with
its **own** `token`, `teamId`, `runKind`, `ownerKind`, `ownerId` and the
pipeline dict. It never calls `getTaskToken` (that resolves only the caller's
own dev run) and is not paged, so more than 100 tasks is one response. The
project id is `pipeline.project_id`; the row has no `projectId` field.
`pipeline.components` is read from the row; `getTaskPipeline(token)` is a
bounded fallback only when a row carries none.

The server scopes a user-owned run by its owner, so `getTasks()` still returns
the caller's own runs from an organization they have switched away from, with
their tokens. Discovery drops a row, before grouping and before its token
reaches the store, when the identity lists its organization's teams
(`identity.teamPermissions`) and the row's `teamId` is not one of them
(`runInIdentityOrganization` in
[`connect/identity.ts`](../../../apps/shared/src/explorer/connect/identity.ts)).
A row with no `teamId`, or an identity without a team list, keeps every row.
This also keeps a platform administrator's Explorer to the organization they
are signed in to. A run under another team of the same organization stays.

A connection is a **role map**, not a provider set
([`types.ts`](../../../apps/shared/src/explorer/types.ts)):

| Spec | Roles | Use |
|---|---|---|
| `SINGLE_TOOLS_ROLE` | one `tools` role, any source | SQL, Graph |
| `VECTOR_ROLES` | `ingest_1`, `chat_1`, `tools_1` (`tools` required) | Vector (tested with mocks; no Vector app ships) |

Multi-role specs group the running sources of **one project, owner kind, owner,
team and run kind** into one connection. Runs that differ in any of those never
merge (a developer's run and the team's deployment of the same pipeline are two
connections). A role with no running source is reported as `null` in
`endpoint.roles` and listed in `missingRoles`; it is never borrowed from another
run. A missing **required** role makes the endpoint `stopped`. Rows whose
pipeline has no `project_id` are never grouped with other rows (multi-role specs).

## Endpoint keys

`buildEndpointKey` ([`keys.ts`](../../../apps/shared/src/explorer/keys.ts))
produces

```text
k1|runKind|ownerKind|ownerId|teamId|projectId|role=source,role=source|nodeId
```

with every field percent-encoded, so a key never contains a raw `:` or `|` and
the documents' "strip one trailing `:segment`" address rule stays exact. Role
bindings are sorted, and a fixed-source role keeps its source in the key while
not running, so a connection's key survives an optional source starting and
stopping. A key is **never derived from a token**.

`legacyKey` is SQL Explorer's old `projectId:source:nodeId`. It is set only for
`runKind === 'dev'`, `ownerKind === 'user'` with a known project id and a
single role (`legacyKeyFromKey`), because that is all the old token lookup could
open. Deployments, other owners and projectless pipelines get `null`.

`projectId` is `''` when a pipeline carries no `project_id` (the server mints one
it never reports). Two such pipelines with the same owner, run kind, source and
node id collide on their key. A `.pipe` file saved in a VS Code workspace gets a
`project_id`; the Graph Explorer templates ship without one and get it on
import, so two copies of one template posted raw through an SDK collide and
show as one card.

## Endpoint states

| State | Meaning |
|---|---|
| `probing` | discovered; the one `dialect` probe is pending |
| `ready` | the probe answered |
| `stopped` | its task is not running (kept in the list after it disappears), or a required role is missing |
| `unreachable` | running, but the probe failed (not wired to a tools source, node error, timeout) |
| `inaccessible` | the probe failed and the identity's team permissions lack `task.data` for that run's team (a hint, never a gate) |

The probe runs once per endpoint, with bounded concurrency (default 4), and one
failure never affects another. A `ready` endpoint is not probed again unless a
refresh asks for it, its token changes, or it disappears and returns. An
`unreachable` or `inaccessible` endpoint is probed again only on an explicit
`store.refresh()`, a restart or reconnect, `store.probe()` (Test connection) or
a changed token, never on a focus or an ordinary task event: a probe is a tool
call, and a tool call that reaches the task counts as activity for its idle
timeout. An endpoint that disappeared from discovery is not probed:
`store.probe()` sends nothing for it and returns null, and the answer to a
probe that was in flight when it disappeared is not applied, so its card stays
`stopped`. It is probed when a discovery lists it again, on any refresh. An
empty `getTasks()` list is not proof that something failed to provision.

## Tokens and identity

Tokens live only in a `Map` inside the store
([`connect/store.ts`](../../../apps/shared/src/explorer/connect/store.ts)).
Endpoints, probe results, the state snapshot, keys, sessions and errors never
contain one, so nothing the library returns can leak one into preferences,
storage, a URL, a log, a copied JSON or a document payload. Call tools only
through `store.session(client, endpoint)`; the session reads the token at call
time and never keeps it.

Discovery lists running tasks only, so a task that is restarting disappears
from it just like a stopped one. An endpoint that disappears is shown
`stopped`, but the store keeps its token, and the node's last good `dialect`
answer for the session's capability check and budget, until the endpoint is
discovered again or the store resets. A call made in the meantime is still
sent, and that is its first send, not a retry. The server holds it until a
restarting task is running again. A pipeline stopped within the last few
minutes is still registered and answers `TASK_STOPPED`, so an idempotent call
first gets the one bounded re-discovery (up to the 15 s retry window, see "The
one retry") and then fails with that code; a task that is no longer registered
answers `TASK_NOT_REGISTERED` at once. A call is refused locally as
`unavailable` only for an endpoint whose latest discovery row carried no token
or reported it `stopped` (a required role not running); its token is dropped
then.

`store.reset()` forgets endpoints, probes, tokens and sessions, and drops probes
that were in flight. It runs on sign-out and when the identity fingerprint
(`userId|orgId|devTeam`, [`connect/identity.ts`](../../../apps/shared/src/explorer/connect/identity.ts))
changes; a permissions-only change does not reset. Wire it with
`useEndpointStoreLifecycle(store, client, identity)` from `react.tsx` (task
events, focus, reconnect, identity events through `shellBinding.ts`).
Refresh is debounced (300 ms) for task events, rate-limited (5 s) for focus, and
concurrent refreshes coalesce into one follow-up. One discovery may take at most
30 s (`discoveryTimeoutMs`); after that the refresh ends with status `error`, so
a server that never answers cannot leave the list refreshing forever.

## Calling a tool

[`connect/session.ts`](../../../apps/shared/src/explorer/connect/session.ts):
`session.invoke(tool, input, { idempotent?, timeoutMs?, generation?, retry? })`
resolves with the checked value or throws `ExplorerToolError`
([`errors.ts`](../../../apps/shared/src/explorer/errors.ts)): `kind` is one of
`raised`, `invalid`, `store`, `error-envelope`, `malformed`, `timeout`,
`upgrade`, `unavailable`, `stale`; `message` is the full verbatim text,
`headline` its first line, `detail` the rest, `code` the server's
machine-readable code when present.

Failure depends on the **tool**, so each tool gets a `ResultCheck`
([`checks.ts`](../../../apps/shared/src/explorer/checks.ts)):

| Tool shape | Failure arrives as | Check |
|---|---|---|
| `execute`, `read_query` | the call rejects; the envelope is validated | `checkRowEnvelope` (positional rows, `row_limit`, `truncated`, additive metadata, `truncated_by` null, `rows`, `elements` or `values`); SQL's `execute` answers with object rows and uses `checkObject` |
| `get_data` | `{valid: false}` with an `error` (even beside an `answer`) or with neither fails; `{valid: false, answer}` with no `error` is a prose answer and passes | `checkValidFlag` (the `get_query` rule) |
| `get_query` | `{valid: false}` with an `error` (even beside an `answer`) or with neither fails; `{valid: false, answer}` with no `error` is prose and passes | `checkGetQuery` |
| store / vector tools | `{success: false, error}` | `checkStoreSuccess` |
| FalkorDB legacy `query` | `{error, columns: [], rows: []}` | `checkLegacyErrorEnvelope` |
| `get_schema`, `refresh_schema` | never an error by itself | `classifySchemaV2` returns `fresh`, `stale`, `error`, `incapable` or `unknown`; an absent `schema` block is `unknown`, never an empty graph |

**Timeouts** come from the session's own timer, never from SDK message text.
The default wait is the node's published `dialect.limits.statement_timeout_ms`
plus 10 s, or 40 s when it is not published. `DEFAULT_TOOL_TIMEOUTS`:

| Tool | Client wait | Why |
|---|---|---|
| `dialect` | 15 s | a name and a few limits |
| `get_schema` | 60 s | serves the snapshot the node already holds |
| `refresh_schema` | 135 s | the node can queue behind another refresh (budget + 5 s) and then reflect for its own budget (`SCHEMA_REFRESH_BUDGET_MS` = 60 s, `packages/ai/src/ai/common/graph/schema.py`): 2 × 60 s + 5 s, plus the 10 s pad |
| `get_data`, `get_query` | 120 s | a model writes the query first |

A client wait must sit above the node's own deadline, otherwise the app says
"stopped waiting" just before the node returns its honest stale or error answer.
A tool spec's `timeoutMs: null` means no client timeout. The
SDK is asked to wait 1 s longer than the session so the session's typed
`timeout` wins. A client timeout does **not** cancel the server's work.

**Stale results.** Each request takes a ticket from `createGeneration()`; passing
it as `generation` makes a result (or failure) that arrives after the ticket
expired throw `kind: 'stale'`, which callers ignore.

**Capability gate.** A tool spec's `capability` names a `dialect.capabilities`
key that must be `true`; otherwise the call is refused locally as `upgrade`
before anything is sent. The library never falls back to another tool (for
example from `read_query` to `execute`).

### The one retry

A call is retried **at most once**, and only when **all** hold:

1. the call is idempotent: `idempotent: true` on the tool's spec, or on the
   call itself. A write never is, and `execute` is not by default; a caller may
   mark one `execute` call idempotent for a statement it classifies as a read
   (SQL Explorer does, for reads, table pages, row counts and plain `EXPLAIN`).
   Such a replay is safe only because of rule 2: `TASK_STOPPED` is raised
   before the request is dispatched, so the first attempt never ran;
2. the failure is `raised` with `code === 'TASK_STOPPED'`, which the server
   raises from `wait_for_running` **before** the request reaches the node;
3. bounded re-discovery (at most 15 s, inside the call's own timeout) finds the
   **same endpoint key** running again (the token may be identical: task tokens
   are deterministic);
4. at least a second of the call's budget remains.

`TASK_NOT_REGISTERED`, `TASK_COMPLETED`, `TASK_AMBIGUOUS`, permission errors,
malformed results, `upgrade` and timeouts are never retried. The server has no
dedicated "restarting" code: a restart and a real stop both give `TASK_STOPPED`,
which is why re-discovery, not the code alone, decides.

This depends on the SDKs preserving the server code. `client.call()` throws
`DAPException` (TypeScript) / `CommandException` (Python), both carrying `.code`
(see the SDKs' `errors.md` pages); the library only reads a string `code`
property and imports no SDK class. With an SDK that drops the code, nothing is
retried.

## History

`createHistoryStore({ historyKey, recordingKey, textField, limits?, runs?,
legacyKeyOf? })` ([`history/store.ts`](../../../apps/shared/src/explorer/history/store.ts))
persists through the shell's workspace preferences, per connection key, and
writes only while a preferences accessor is attached (see the file header for
why a background write would be misfiled). SQL Explorer uses `sql.history`,
`sql.historyRecording`, `sql.patternChecks` and the persisted field `sql`; Graph
Explorer uses `graph.history`, `graph.historyRecording` and `cypher`. It has no
pattern-check switch: its write console always confirms the statements its text
check flags and sends the rest without a dialog, with no option to stop asking.
**These names and the entry shape never change**: renaming one
silently orphans users' saved history. Mount the accessor with
`createHistoryPrefsBridge(store)` from `react.tsx`. The store keeps what it read
after the last bridge detaches and merges it into the next attach, so the bridge
attaches under the signed-in identity's fingerprint (`attachPrefs(api, owner)`,
the owner read with the shell's `useAuthUser`) and attaches again when it
changes. An attach under a different owner, a sign-out included, first forgets
every entry, switch, queued run and pending write held in memory, so one
account's history is never shown to, merged into or written for the next one
that signs in on the same page. Per-connection booleans use
`createConnectionFlags` ([`history/flags.ts`](../../../apps/shared/src/explorer/history/flags.ts)).

**Legacy keys.** When `legacyKeyOf` maps a connection to its pre-v1 key (SQL
passes `legacyKeyFromKey`), reads are a merged view of both lists. No automatic
write touches the old list, because several new keys can read one old key (the
same dev run under two development teams). New runs go to the new key only, and
the per-connection bound applies to the merged view, so an old entry it leaves
out stays stored. Pin, note and a re-run that repeats an old statement write a
copy under the new key (same id, so the copy stands in for the original). Remove
and clear are the user's own deletes and do reach the old list: remove drops the
entry from both lists, and clear empties the connection's own list and the old
list, so every connection reading that old list stops seeing them. A recording
or pattern-check switch saved under the old key still applies until the new key
has its own. Nothing is migrated, and a deployment or another owner never reads
the old list. Apart from remove and clear, the only thing that can drop an old
entry is the size budget across all connections (`trimBag`, oldest first).

## Running statements

[`runner/batch.ts`](../../../apps/shared/src/explorer/runner/batch.ts) holds
`runStatementBatch`, pure and testable with a fake session; the app supplies the
language-specific hooks. Its rules: one statement per call, in order; the first
failure ends the batch and the rest are `skipped` (no claim of atomicity); a
`refuse` hook can veto the whole batch before anything is sent; a text pattern
check asks before a flagged statement is sent (run, run and stop asking, or
decline, which skips the rest); when the batch's generation ticket expires
(Stop waiting, or the component that owns the runner unmounting: a closed
document, a switch to another app) it sends nothing more, stops touching state,
and the late result **and** the late failure are dropped. The statement already
in flight finishes at the node; nothing can cancel it. `abandonRuns` marks the
statement in flight `abandoned`.
[`runner/useStatementRunner.ts`](../../../apps/shared/src/explorer/runner/useStatementRunner.ts)
binds it to React state; its unmount cleanup (`attachRunnerLifetime`) is what
expires the ticket, so every app using the hook gets this without code of its own.

Shared components under `components/` (import by path): `StatementStrip`,
`FailureBanner` (headline, where it happened, "Database said" collapsed),
`PatternConfirmDialog` (its sentence "This is a text check, not a database
safeguard." is fixed), `RowInspector` (positional fields, so duplicate column
names survive), `ConnectionsLanding` and `EndpointDrawer` (the app injects its
wording, icon, probe, extra rows and empty states; state wording is in
`endpointState.ts`). Also pure: `a11y/` (`createAnnouncer`,
`createLiveRegion`), `nav/` (`createActiveKeyStore`, `createRequestChannel`,
document-URI key rule), and the drawer's selection and probe rules
(`components/drawerModel.ts`).

## Adding an Explorer app

1. Create the app with the normal app scaffold (see
   [Building Shell Apps in the Monorepo](index.md)).
2. In its own modules, create one instance of each store it needs:
   `createEndpointStore({ providers, roles, tools })` with its exact provider
   set, `createHistoryStore` with its own preference keys and text field, an
   announcer, an active-key store. Never import another app's instance.
3. Describe every tool the app calls in the `tools` map: `idempotent`,
   `check`, `timeoutMs`, `capability`. Reads and reflection are idempotent;
   `execute` is not (a call may still mark one statement it knows is a read,
   see "The one retry").
4. Mount `useEndpointStoreLifecycle(store, client, identity)` once at the app
   root, and call tools only through `store.session`. The store resets when
   the identity fingerprint changes (sign-out included); the app must then
   close every connection-scoped document (keep the Connections landing) and
   clear its per-connection caches, such as schema snapshots, cached sessions
   and reads in flight, as SQL Explorer (`identityScope.ts`) and Graph
   Explorer (`graph/identityChange.ts`) do. The shared `EndpointDrawer` needs
   nothing extra: when the store resets, it forgets its selection and drops
   the probe result, including one still in flight. Nor does history: the
   bridge from `createHistoryPrefsBridge` makes the history store forget the
   previous identity's entries (see [History](#history)).
5. Wire the runner's hooks and the shared components; keep the language
   (lexer, classifier, row limits, failure wording) in the app.
6. Tests: pure logic runs under the app's `*:test` action; for `shared:test`,
   keep suites beside the code. `connect/testing.ts` has a fake client and a
   manual clock (not exported from the barrel).

## Known limits

- The React hook and the components that import from `shell` are type-checked
  and bundled but have no DOM tests: the repository has no component test
  harness. The runner's rules are covered by the pure batch suite.
- Vector roles are tested with mocks only.
- A pipeline launched without `project_id` can collide with a lookalike (see
  [Endpoint keys](#endpoint-keys)).
- The server has no `TASK_RESTARTING` code and no permission-denied code, so
  `inaccessible` is an identity-permission hint plus a failed probe, and a retry
  needs re-discovery.
- SQL Explorer's `execute` has no client timeout (SQL nodes set no statement
  deadline; the app offers Stop waiting). Schema reflection waits up to 5
  minutes and the engine check 15 seconds.
- Nothing cancels a running tool call. Stop waiting stops the client, not the
  node.
