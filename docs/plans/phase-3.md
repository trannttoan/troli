# Task: Implement Phase 3 — Tasks

## Problem Statement

Phase 2 is complete: the agent has full Google Calendar CRUD, a working ReAct tool-calling loop, and the HITL interrupt/resume flow (backend `interrupt()` + mobile approval cards + reopen hydration). Phase 3 adds Google Tasks support following the same pattern.

This means:

1. Six task tools implemented against the Google Tasks API: `list_task_lists`, `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`
2. `update_task` and `delete_task` behind HITL approval, reusing the existing interrupt plumbing — except status-only updates (mark complete/incomplete), which execute directly
3. OAuth scopes expanded to include `https://www.googleapis.com/auth/tasks`, with forced re-auth for existing sessions
4. Tool unit tests with mocked API responses

Phase 3 is faster than Phase 2 because all cross-cutting infrastructure already exists: `fetchWithAuth`, the ReAct loop, the interrupt payload contract, the approval card UI, scope-mismatch detection, and reopen hydration are all generic and need no structural changes.

## Inconsistencies & Blockers (found and resolved 2026-07-31)

Doc-level inconsistencies were patched in PRD/TRD/BUILD.md when this plan was drawn up; the remaining items below are implementation work or checklist items.

1. **BUILD.md omitted the OAuth scope expansion (blocker — now a subtask).** Without adding `https://www.googleapis.com/auth/tasks` to `GOOGLE_SCOPES`, every Tasks API call will 403. The scope-mismatch machinery from Phase 2 (stored scopes + `hasRequiredScopes()` in `mobile/src/store/auth.ts`) already forces re-auth when `GOOGLE_SCOPES` grows, so the fix is one array entry plus message wording — but it gates all on-device testing of task tools. BUILD.md Phase 3 now lists this bullet; the code change is Subtask 1.1.
2. **Two user-facing messages are hardcoded to "calendar access."** `mobile/src/utils/auth.ts:113` (insufficient-scope error) and `mobile/src/store/auth.ts:28` (`SCOPE_MISMATCH_MESSAGE`). Both reworded in Subtask 1.1.
3. **BUILD.md's "System prompt instructs agent to ask which list" was already done.** The rule shipped in Phase 1/2 (`backend/src/prompt.ts`). BUILD.md now says verify-only. (A different, small prompt change IS needed — the mark-complete approval exception, see item 5 — handled in Subtask 4.1.)
4. **GCP prerequisite to verify, not build.** TRD section 2.2 says the `tasks` scope was declared on the consent screen in Phase 0. Verify in the Google Cloud console that the Tasks API is enabled and the `tasks` scope is listed before starting Slice 1 — a missing declaration surfaces as a consent-screen error, not a code bug. Test mode (100 users) is fine for a sensitive scope; no verification needed until App Store release (PRD section 4).
5. **Mark-as-complete no longer requires approval (decision reversed, docs patched).** TRD 3.4 / PRD 5.2 originally put `status: "completed"` behind the `update_task` interrupt. Decision: status-only updates (mark complete/incomplete) execute directly — completion is reversible and low-risk, and an approval card for "mark buy milk as done" is needless friction. PRD 5.2, TRD 3.4 (footnote), TRD 3.6 prompt template, and BUILD.md now reflect this. Updates touching any other field still interrupt. Implementation in Subtask 4.1.
6. **Google Tasks API quirks that differ from Calendar** (see Constraints below): `due` is date-only (time portion discarded by the API), list endpoints default to `maxResults=20` (silent truncation far more likely than Calendar's 250), completed tasks are hidden from listings unless `showHidden=true`, and there is no server-side ordering or free-text query parameter.
7. **Pre-existing TRD staleness — patched.** TRD 3.4 calendar rows no longer list `thisAndFollowing` as available (marked deferred post-v1.0, matching the Phase 2 scope cut); the TRD 3.5 example now reads `config.configurable.access_token` (matching the implementation); and the TRD 3.6 prompt template's recurring-scope wording now matches the shipped prompt ("the whole series", not "all future occurrences").

No hard blockers beyond the scope expansion — everything else is additive.

## Relevant Files

### Backend — will create or modify

- `backend/src/tools/tasks.ts` — New: all 6 task tool definitions
- `backend/src/agent.ts` — Register task tools (see "Tool registration" below — tools are currently bound in two places)
- `backend/src/__tests__/tools/tasks.test.ts` — New: tool unit tests (mocked `fetchWithAuth`)
- `backend/src/__tests__/agent.test.ts` — Extend: integration coverage for a task tool through the ReAct loop + interrupt

### Mobile — will create or modify

- `mobile/src/utils/auth.ts` — Add `tasks` scope to `GOOGLE_SCOPES`; reword `insufficient_scope` message
- `mobile/src/store/auth.ts` — Reword `SCOPE_MISMATCH_MESSAGE`
- `mobile/src/store/__tests__/auth.test.ts` — Extend: scope-mismatch coverage for the new scope

### Mobile — no changes expected (verified generic)

- `mobile/src/services/langgraph.ts` — `extractInterruptPayload` validates only `action: string` + `description` + `current`/`proposed`; task payloads flow through unchanged
- `mobile/src/components/ApprovalCard.tsx` — `formatActionLabel` sentence-cases any snake_case action (`update_task` → "Update task"); current/proposed sections render generic key-value entries
- `mobile/src/store/chat.ts` — interrupt/resume flow is action-agnostic

### Docs

- `docs/plans/phase-3-test.md` — New: manual test cases (mirror `phase-2-test.md` structure)

## Patterns & Conventions Observed

### Backend (established in Phase 2 — follow exactly)

- **Tool shape**: `tool(async (input, config) => string, { name, description, schema })` from `@langchain/core/tools`. Tools return formatted strings, never raw JSON. IDs included as `(id: ...)` for the agent's use but the system prompt forbids showing them to users.
- **Auth**: `getAccessToken(config)` reads `config.configurable.access_token`, throws `TroliAuthError('AUTH_MISSING_ACCESS_TOKEN', ...)` when absent. Currently private to `calendar.ts` — extract to a shared util rather than duplicating (see Slice 1).
- **HTTP**: All Google calls go through `fetchWithAuth<T>(url, init, accessToken)` (`backend/src/utils/google-api.ts`). It already handles empty bodies (calendar DELETE), and maps 401/403/429 to typed errors.
- **Missing resources**: Calendar treats 404/410 as "already gone" (`isMissingResourceStatus`). For Tasks, handle 404 the same way; also handle Tasks' soft-delete flag (`deleted: true` on the resource) — verify actual API behavior at implementation time rather than assuming parity with Calendar.
- **HITL contract**: `interrupt<Payload, 'approve' | 'reject'>({ action, description, current, proposed })`. Update tools pass a `current` snapshot + `proposed` diff; delete tools pass `proposed: null`. Non-approve decisions return a cancellation string ("Update cancelled." / "Deletion cancelled.").
- **Pre-interrupt fetch**: Write tools fetch the current resource first, short-circuit with a friendly message if missing or already deleted/completed-as-relevant, and only then interrupt.
- **Timestamping**: `toolsNode` in `agent.ts` stamps tool messages; nothing to do per-tool.
- **Testing**: Vitest, `vi.mock('../utils/google-api.js')`-style module mocks, mocked model returns tool-call message then final text for ReAct integration tests. ESM imports with `.js` extensions.

### Mobile

- Scope expansion pattern from Phase 2 slice 1.4: add to `GOOGLE_SCOPES`, stored-scope comparison in `initialize()` forces sign-out with `SCOPE_MISMATCH_MESSAGE`. Already generic — only the array and messages change.

## Constraints & Risks

### 1. Tool registration touches two places (easy to miss)

`backend/src/agent.ts` binds `calendarTools` in **both** `new ToolNode(calendarTools)` (line 83) and `getModel().bindTools(calendarTools)` (line 103). Registering task tools in only one breaks either execution or selection. Introduce a single `const allTools = [...calendarTools, ...taskTools]` used in both spots.

### 2. `due` is date-only

The Tasks API `due` field is RFC3339, but **the API discards the time portion** — due dates are dates, not datetimes. The tool schema should accept `YYYY-MM-DD` (reusing the calendar tools' date-validation approach) and convert to `{due: "YYYY-MM-DDT00:00:00.000Z"}` on write, and format back to a plain date on read. Do not let the agent promise "due at 3pm" — a schema description noting that Google Tasks has no due _times_ keeps the agent honest.

### 3. List truncation defaults are aggressive

`GET /lists/{taskListId}/tasks` and `GET /users/@me/lists` default to `maxResults=20` (max 100). A default list with 25 tasks would be silently truncated. Set `maxResults=100` explicitly and, when `nextPageToken` is present, append the same "list is incomplete" note used by `list_calendar_events`. Full pagination is deferred (same stance as Phase 2's calendar scope limitation).

### 4. Completed and hidden tasks

Completed tasks get `hidden: true` once cleared in Google's UI and disappear from default listings. `list_tasks` should expose an optional `showCompleted` input (mapped to `showCompleted=true&showHidden=true`) so "what did I finish this week?" works, while defaulting to open tasks only. Verify exact flag interaction at implementation time — the `showCompleted`/`showHidden` semantics are the least-documented corner of this API.

### 5. No server-side search or ordering

Unlike Calendar, the Tasks API has no `q` query and no `orderBy` — tasks come back in manual position order, with `dueMin`/`dueMax`/`completedMin`/`completedMax` as the only filters. `list_tasks` supports optional `dueMin`/`dueMax` (date strings) and otherwise returns the list as-is; the agent does any "find the task about X" matching from the formatted output. Do not fabricate a `query` parameter.

### 6. Un-completing a task

Setting `status: "needsAction"` must also clear the `completed` timestamp field (send `completed: null` in the PATCH). Cover with a unit test — this is the classic Tasks API gotcha.

### 7. Task list disambiguation is prompt-driven, not schema-driven

`create_task` requires `taskListId`. The agent must call `list_task_lists` first to resolve a name → ID (or ask the user, per the existing prompt rule). Make the `create_task` schema description state that the ID comes from `list_task_lists` — the agent must never invent one. `@default` list ID (`"@default"`) is valid for the user's default list; allow the agent to use it when the user says "my default list" but not as a silent fallback (the prompt rule says ask).

### 8. Interrupt payload snapshots

Follow the calendar `toEventSnapshot`/`toProposedUpdateSnapshot` pattern with task-shaped snapshots: `{ taskId, taskListId, title, notes?, due?, status? }` for `current`, field-diff object for `proposed`. The ApprovalCard renders whatever keys appear — keep keys human-readable.

## Resolved Questions (do not re-open)

1. **Mark-as-complete bypasses HITL.** Status-only `update_task` calls (complete or un-complete) execute directly; any update touching other fields interrupts. PRD 5.2, TRD 3.4/3.6, and BUILD.md were patched to match (2026-07-31). The system prompt gains the exception line already present in the TRD 3.6 template.
2. **No mobile HITL changes.** Payload extraction, approval card, resume, and reopen hydration are action-agnostic (verified against the current source). If a task approval renders poorly, fix formatting via the payload snapshot keys, not the card component.
3. **Pagination deferred.** `maxResults=100` + truncation note, matching the calendar precedent.
4. **Primary/default task list**: no special-casing beyond accepting `"@default"`. The agent asks which list when unspecified, per the existing prompt rule.

## Scope limitations (Phase 3)

- **Task list CRUD**: read-only (`list_task_lists`). Creating/renaming/deleting task lists is out of scope (not in TRD 3.4).
- **Subtasks/nesting**: `parent`/`position` fields ignored; tasks render flat.
- **Pagination**: capped at 100 tasks / 100 lists with a truncation note; `nextPageToken` paging deferred.
- **Task moves**: moving tasks between lists is out of scope (requires delete+create or the `move` endpoint; not in TRD).

## Subtasks

### Slice 1: Walking skeleton — scope + first task tool end-to-end

#### 1.1 — OAuth scope expansion

- **Description**: Add `https://www.googleapis.com/auth/tasks` to `GOOGLE_SCOPES` in `mobile/src/utils/auth.ts`. Reword the `insufficient_scope` message (`utils/auth.ts:113`) and `SCOPE_MISMATCH_MESSAGE` (`store/auth.ts:28`) to "calendar and tasks access". Existing stored-scope comparison forces re-auth automatically — no logic changes.
- **Files involved**: `mobile/src/utils/auth.ts` (modify), `mobile/src/store/auth.ts` (modify), `mobile/src/store/__tests__/auth.test.ts` + `mobile/src/utils/__tests__/auth.test.ts` (extend)
- **Prerequisites**: Verify Tasks API enabled + `tasks` scope declared in the GCP console (5-minute check, see Inconsistencies item 4)
- **Acceptance criteria**: Stored session without the tasks scope → `initialize()` signs out with the updated message. Fresh sign-in requests and stores the new scope. Existing tests updated for the new `GOOGLE_SCOPES` length pass.
- **Estimated scope**: Small

#### 1.2 — `list_task_lists` + shared token helper + tool registration

- **Description**: Create `backend/src/tools/tasks.ts` with `list_task_lists` (no inputs; `GET https://www.googleapis.com/tasks/v1/users/@me/lists?maxResults=100`; formats `- {title} (id: {id})`, truncation note on `nextPageToken`). Extract `getAccessToken()` from `calendar.ts` into a shared util (e.g. `backend/src/utils/tool-config.ts`) and import from both tool files. In `agent.ts`, introduce `allTools = [...calendarTools, ...taskTools]` and use it in both `new ToolNode(...)` and `bindTools(...)`.
- **Files involved**: `backend/src/tools/tasks.ts` (create), `backend/src/utils/tool-config.ts` (create), `backend/src/tools/calendar.ts` (modify — import shared helper), `backend/src/agent.ts` (modify), `backend/src/__tests__/tools/tasks.test.ts` (create)
- **Prerequisites**: 1.1 (for on-device verification; unit tests don't need it)
- **Acceptance criteria**: Unit tests: formats lists, empty state ("No task lists found."), truncation note, missing-token error. Existing calendar tests still pass after the helper extraction. Manual: "what task lists do I have?" answers correctly on device.
- **Estimated scope**: Medium

---

### Slice 2: Read breadth

#### 2.1 — `list_tasks`

- **Description**: Zod schema: `taskListId` (required), `dueMin`/`dueMax` (optional `YYYY-MM-DD`, converted to RFC3339), `showCompleted` (optional boolean, default false → adds `showCompleted=true&showHidden=true`). `GET /lists/{taskListId}/tasks?maxResults=100`. Format: title, due date (date-only), status, notes-present marker, `(id: ...)`; truncation note on `nextPageToken`. 404 on the list ID → "No task list found with ID '...'."
- **Files involved**: `backend/src/tools/tasks.ts` (modify), `backend/src/__tests__/tools/tasks.test.ts` (extend)
- **Prerequisites**: 1.2
- **Acceptance criteria**: Unit tests: default listing, due-range filters, completed included when requested, empty list, truncation note, 404 handling.
- **Estimated scope**: Medium

#### 2.2 — `get_task`

- **Description**: Zod schema: `taskListId`, `taskId` (both required). `GET /lists/{taskListId}/tasks/{taskId}`. Formatted detail: title, status, due, notes, completed timestamp when present, `deleted: true` surfaced as "this task has been deleted."
- **Files involved**: `backend/src/tools/tasks.ts` (modify), `backend/src/__tests__/tools/tasks.test.ts` (extend)
- **Prerequisites**: 1.2
- **Acceptance criteria**: Unit tests: full detail, minimal task (title only), 404 → friendly message, deleted-task message.
- **Estimated scope**: Small

---

### Slice 3: Create

#### 3.1 — `create_task`

- **Description**: Zod schema: `taskListId` (required — description: "obtain from list_task_lists or ask the user; '@default' targets the default list"), `title` (required, trimmed non-empty), `due` (optional `YYYY-MM-DD`, validated with the calendar tools' real-date check, converted to `T00:00:00.000Z`; description notes Google Tasks has no due times), `notes` (optional). `POST /lists/{taskListId}/tasks`. No HITL (per TRD). Returns formatted created task.
- **Files involved**: `backend/src/tools/tasks.ts` (modify), `backend/src/__tests__/tools/tasks.test.ts` (extend)
- **Prerequisites**: 2.1 (list formatting conventions established)
- **Acceptance criteria**: Unit tests: create with/without due and notes, invalid date rejected by schema, 404 list → friendly message. Manual: "add a task to buy groceries by Saturday" → agent asks which list if unspecified (existing prompt rule), creates directly once known.
- **Estimated scope**: Small

---

### Slice 4: HITL writes + verification

#### 4.1 — `update_task` + prompt exception

- **Description**: Zod schema: `taskListId`, `taskId` (required); optional `title`, `notes`, `due` (`YYYY-MM-DD`), `status` (`needsAction` | `completed`); `.superRefine` requires ≥1 update field. Flow mirrors `update_calendar_event`: fetch current → short-circuit on 404 / `deleted: true` → if already in the requested state (e.g. completing a completed task) return a no-op message without interrupting → **if the update is status-only (only `status` among the update fields), skip the interrupt and execute directly** (per TRD 3.4 footnote — completion is reversible) → otherwise `interrupt({ action: 'update_task', description, current, proposed })` → on approve, `PATCH /lists/{taskListId}/tasks/{taskId}`; on reject, "Update cancelled." When `status: "needsAction"`, include `completed: null` in the PATCH body. Description strings: `Update "{title}": {changes}`. Also add the approval-exception line from the TRD 3.6 template to `backend/src/prompt.ts` ("Exception: marking a task complete or incomplete does not need approval — do it directly.").
- **Files involved**: `backend/src/tools/tasks.ts` (modify), `backend/src/prompt.ts` (modify), `backend/src/__tests__/prompt.test.ts` (extend), `backend/src/__tests__/tools/tasks.test.ts` (extend), `backend/src/__tests__/agent.test.ts` (extend — one ReAct + interrupt integration test with a task tool)
- **Prerequisites**: 2.2
- **Acceptance criteria**: Unit tests: status-only complete patches directly with no `interrupt()` call; status-only un-complete patches directly with `completed: null`; mixed update (e.g. `status` + `title`) interrupts; approve patches; reject cancels; interrupt payload shape; no-op completion short-circuit; 404 handling. Prompt test covers the exception line. Integration: graph interrupts on a non-status `update_task` and resumes on approve.
- **Estimated scope**: Medium

#### 4.2 — `delete_task`

- **Description**: Zod schema: `taskListId`, `taskId`. Fetch current → short-circuit on 404 / already `deleted: true` → `interrupt({ action: 'delete_task', description: 'Delete "{title}".', current, proposed: null })` → on approve, `DELETE /lists/{taskListId}/tasks/{taskId}` (204 empty body — `fetchWithAuth` already tolerates this); on reject, "Deletion cancelled."
- **Files involved**: `backend/src/tools/tasks.ts` (modify), `backend/src/__tests__/tools/tasks.test.ts` (extend)
- **Prerequisites**: 4.1 (interrupt conventions for tasks established)
- **Acceptance criteria**: Unit tests: approve deletes, reject cancels, `proposed: null` in payload, already-deleted short-circuit, 404 after approval → "may no longer exist" message.
- **Estimated scope**: Small

#### 4.3 — Manual end-to-end verification + test doc

- **Description**: Create `docs/plans/phase-3-test.md` mirroring `phase-2-test.md`: scope re-auth on upgrade, list/get flows, create with list disambiguation, mark-complete executes directly (no approval card), un-complete restores the task, non-status update shows an approval card (verify generic card renders task snapshots legibly), reject path, delete flow, close-app-during-pending-approval reopen, delete-during-pending-approval. Run on device against the deployed backend; record pass/fail.
- **Files involved**: `docs/plans/phase-3-test.md` (create)
- **Prerequisites**: 4.1, 4.2, deployed backend
- **Acceptance criteria**: All manual cases documented and passing; any approval-card formatting issues fixed via snapshot keys (not card changes) or logged for Phase 5.
- **Estimated scope**: Small
