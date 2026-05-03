# Plan: Notification Service — TUI Badge + macOS System Notification

## Summary
Implement a notification service that dispatches alerts via two channels: TUI badge (⚠ icon on PR group) and macOS system notifications (`osascript`). The service is driven by `step_result` values already set by the scheduler (`needs-input`, errors) and is configurable via `config.notifications.system`.

## User Story
As an orchestrator operator,
I want visual and system-level alerts when an agent needs my attention,
So that I don't have to stare at the dashboard to catch blocking events.

## Problem → Solution
No notification mechanism — user must watch dashboard → `notify(message, level)` dispatches to TUI badge and macOS notification, configurable and gracefully degrading.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (GitHub issue #14)
- **PRD Phase**: N/A
- **Estimated Files**: 7 (3 create, 4 update)

---

## UX Design

### Before
```
┌─────────────────────────────────┐
│ PR Groups     │ Main View       │
│ ⚙ pr-5 (1/3) │ ...             │
│ · pr-2 (0/2) │                 │
│               │                 │
├───────────────┤                 │
│ Issues        │                 │
├───────────────┤                 │
│ Activity      │                 │
└─────────────────────────────────┘
  No indication when agent blocked
```

### After
```
┌─────────────────────────────────┐
│ PR Groups     │ Main View       │
│ ⚠ pr-5 (1/3) │ ...             │  ← badge appears
│ · pr-2 (0/2) │                 │
│               │                 │
├───────────────┤                 │
│ Issues        │                 │
├───────────────┤                 │
│ Activity      │                 │
└─────────────────────────────────┘
  + macOS notification popup
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| PR Groups panel | Shows step icon only | Shows ⚠ badge when `needs-input` | Already handled by `getGroupIcon` if step_result is set correctly |
| macOS notification | None | `display notification` for blocking events | Fires once per state transition, not per poll |
| Config toggle | N/A | `config.notifications.system` disables system notifications | TUI badge always shows |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts` | 29-42 | NotificationConfig, OrchestratorConfig — already has `notifications.system` |
| P0 | `src/tui/status-icon.ts` | 1-20 | getStatusIcon/getGroupIcon — ⚠ already mapped to `needs-input` |
| P0 | `src/tui/use-status-poller.ts` | 1-80 | Polling loop — where notification dispatch hooks in |
| P0 | `src/tui/PRGroupsPanel.tsx` | 1-49 | Current badge rendering — uses `getGroupIcon` |
| P1 | `src/config.ts` | 1-99 | Config loading, DEFAULT_CONFIG already has `notifications.system: true` |
| P1 | `src/scheduler.ts` | 53-191 | processIssue — sets `step_result` on failures |
| P1 | `src/tui/Dashboard.tsx` | 1-78 | Dashboard composition — where config is loaded |
| P2 | `src/tui/Dashboard.test.tsx` | 1-335 | Test patterns — `makeGroup()`, `render()`, `lastFrame()` |
| P2 | `src/orchestrate.ts` | 65-96 | wrapWithProgress — pattern for intercepting status writes |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/tui/status-icon.ts:1-2, src/tui/use-status-poller.ts:1
// Files: kebab-case (notification-service.ts)
// Functions: camelCase (sendSystemNotification)
// Types: PascalCase (NotificationLevel)
// Test files: same-name.test.ts
```

### ERROR_HANDLING
```typescript
// SOURCE: src/scheduler.ts:34-41
function safeWriteStatus(deps: SchedulerDeps, slug: string, data: GroupStatus): void {
    try {
        deps.writeGroupStatus(slug, data);
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[scheduler] status write failed for ${slug}: ${detail}\n`);
    }
}
```

### IMMUTABLE_STATE
```typescript
// SOURCE: src/tui/use-status-poller.ts:70
setActivity((prev) => [...newEvents, ...prev].slice(0, 50));
```

### TYPE_GUARD
```typescript
// SOURCE: src/config.ts:49-66
export function validateConfig(value: unknown): value is OrchestratorConfig {
    // runtime shape validation with type narrowing
}
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/tui/Dashboard.test.tsx:20-32
function makeGroup(overrides?: Partial<GroupStatus>): GroupStatus {
    return {
        pr_group: 'pr-5',
        branch: 'feat/tui-dashboard',
        current_issue: 11,
        step: 'coding',
        step_result: '',
        issues_completed: [9],
        issues_remaining: [11, 12],
        last_updated: '2026-05-03T13:42:00.000Z',
        ...overrides,
    };
}
```

### SERVICE_EXPORT
```typescript
// SOURCE: src/status-manager.ts (module pattern)
// Functional exports, no classes. Pure functions with optional baseDir param.
export function readGroupStatus(groupSlug: string, baseDir?: string): GroupStatus | null { ... }
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/tui/notification-service.ts` | CREATE | Core `notify()` function + `sendSystemNotification()` |
| `src/tui/notification-service.test.ts` | CREATE | Tests for notify, config toggle, osascript mocking |
| `src/tui/use-notifications.ts` | CREATE | React hook that watches group state transitions and calls notify |
| `src/tui/use-status-poller.ts` | UPDATE | Export `deriveActivity` for reuse (currently private) |
| `src/tui/PRGroupsPanel.tsx` | UPDATE | Use `getStatusIcon` for per-group badge (shows ⚠ for needs-input) |
| `src/tui/Dashboard.tsx` | UPDATE | Wire `useNotifications` hook, pass config |
| `src/tui/types.ts` | UPDATE | Add `NotificationLevel` type |

## NOT Building
- Sound notifications
- Slack/webhook notifications
- Notification history or log
- Custom notification templates
- Rate limiting / deduplication beyond transition-based firing

---

## Step-by-Step Tasks

### Task 1: Add NotificationLevel type
- **ACTION**: Add notification level union type to TUI types
- **IMPLEMENT**: `export type NotificationLevel = 'info' | 'warning' | 'error';`
- **MIRROR**: NAMING_CONVENTION (PascalCase types in types.ts)
- **FILE**: `src/tui/types.ts`
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create notification-service.ts
- **ACTION**: Create notification service module with two functions
- **IMPLEMENT**:
  - `sendSystemNotification(message: string): Promise<boolean>` — runs `osascript -e 'display notification "..." with title "Orchestrator"'` via `execFile`. Returns true on success, false on failure (non-macOS). Logs to stderr on error, never throws.
  - `notify(message: string, level: NotificationLevel, config: NotificationConfig): Promise<void>` — if `config.system` is true, calls `sendSystemNotification`. Always returns (TUI badge is handled separately by the component).
- **MIRROR**: ERROR_HANDLING (stderr logging, never throws), SERVICE_EXPORT (functional module)
- **IMPORTS**: `import { execFile } from 'node:child_process';`, `import { promisify } from 'node:util';`, types from `'../types.js'` and `'./types.js'`
- **GOTCHA**: `execFile` not `exec` — no shell injection risk. Quote message content by passing as argument array, not string interpolation. Use `promisify(execFile)` for async.
- **VALIDATE**: Unit tests pass, `pnpm run typecheck`

### Task 3: Create use-notifications.ts hook
- **ACTION**: Create React hook that watches group state transitions and fires notifications
- **IMPLEMENT**:
  - `useNotifications(groups: readonly GroupStatus[], config: NotificationConfig): void`
  - Track previous group states via `useRef<Map<string, string>>()` (maps `pr_group` → `step_result`)
  - On each render, diff current vs previous. Fire `notify()` when a group transitions TO:
    - `step_result === 'needs-input'` → level `'warning'`, message `"${pr_group}: needs input"`
    - `step_result` starts with `'worktree error'` or `'worker error'` → level `'error'`, message `"${pr_group}: ${step_result}"`
    - `step === 'reviewing'` and `step_result === 'ready for self-review'` → level `'info'`, message `"${pr_group}: review cycle complete"`
  - Do NOT fire for: empty step_result, `'pass'`, step_result unchanged from previous poll
- **MIRROR**: IMMUTABLE_STATE (new Map on each diff), existing hook pattern in `use-status-poller.ts`
- **IMPORTS**: `{ useEffect, useRef }` from react, `{ notify }` from notification-service, types
- **GOTCHA**: Must only fire on transitions, not every poll. The ref comparison prevents duplicate notifications.
- **VALIDATE**: Unit tests, manual test with mock status files

### Task 4: Update PRGroupsPanel badge
- **ACTION**: Show ⚠ badge per-group when `step_result === 'needs-input'`
- **IMPLEMENT**: Import `getStatusIcon` and use it alongside `getGroupIcon`. When `group.step === 'idle' && group.step_result === 'needs-input'`, the existing `getStatusIcon` already returns `⚠`. Change the icon logic:
  ```tsx
  const icon = group.step === 'idle' && group.step_result
      ? getStatusIcon(group.step, group.step_result)
      : getGroupIcon(group.issues_completed.length, group.issues_remaining.length, group.step);
  ```
  This shows ⚠ for needs-input, ⏸ for blocked, ✓ for pass, while preserving ⚙ for active steps.
- **MIRROR**: Existing icon mapping in `status-icon.ts`
- **IMPORTS**: `{ getStatusIcon }` from `'./status-icon.js'`
- **GOTCHA**: `getGroupIcon` doesn't consider `step_result` — that's why we need `getStatusIcon` for idle states with results.
- **VALIDATE**: Existing `PRGroupsPanel` tests still pass, add test for ⚠ badge

### Task 5: Wire hook into Dashboard
- **ACTION**: Add `useNotifications` hook to Dashboard component
- **IMPLEMENT**:
  - Load config in Dashboard (add `config` prop or load inline)
  - Call `useNotifications(groups, config.notifications)` inside Dashboard
  - Pass `config` as a new prop: `readonly config?: OrchestratorConfig` with a sensible default
- **MIRROR**: Existing hook usage pattern in Dashboard (useScreenSize, useStatusPoller, useKeyboard)
- **IMPORTS**: `{ useNotifications }` from `'./use-notifications.js'`
- **GOTCHA**: Config is loaded once at mount, not per-poll. If no config prop, use DEFAULT_CONFIG.notifications.
- **VALIDATE**: Dashboard renders without errors, typecheck passes

### Task 6: Write tests
- **ACTION**: Create comprehensive test file for notification service and hook
- **IMPLEMENT**:
  - `notification-service.test.ts`:
    - Test `sendSystemNotification` success (mock execFile resolving)
    - Test `sendSystemNotification` failure (mock execFile rejecting — non-macOS)
    - Test `notify` with `config.system: true` calls sendSystemNotification
    - Test `notify` with `config.system: false` does NOT call sendSystemNotification
  - Update `Dashboard.test.tsx`:
    - Test PRGroupsPanel shows ⚠ when group has `step: 'idle', step_result: 'needs-input'`
    - Test PRGroupsPanel shows ⏸ when group has `step: 'idle', step_result: 'blocked'`
    - Test badge clears (shows ✓ or ·) when step_result changes
- **MIRROR**: TEST_STRUCTURE (makeGroup factory, vitest, render/lastFrame)
- **IMPORTS**: vitest mocking (`vi.mock`, `vi.fn`), existing test utilities
- **GOTCHA**: Must mock `node:child_process` for osascript tests. Use `vi.mock('node:child_process')`.
- **VALIDATE**: `pnpm run test -- --run` all pass

### Task 7: Export deriveActivity (minor refactor)
- **ACTION**: Export `deriveActivity` from `use-status-poller.ts` so notification hook can reuse transition detection pattern
- **IMPLEMENT**: Change `function deriveActivity(` to `export function deriveActivity(`
- **MIRROR**: SERVICE_EXPORT
- **GOTCHA**: No breaking change — only adds export. Check no circular imports.
- **VALIDATE**: Typecheck + existing tests pass

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| sendSystemNotification succeeds | valid message | returns true | No |
| sendSystemNotification fails gracefully | osascript not found | returns false, no throw | Yes |
| notify dispatches when config.system true | message + warning | calls sendSystemNotification | No |
| notify skips when config.system false | message + warning | does NOT call sendSystemNotification | No |
| PRGroupsPanel shows ⚠ badge | group with needs-input | frame contains ⚠ | No |
| PRGroupsPanel shows ⏸ badge | group with blocked | frame contains ⏸ | No |
| PRGroupsPanel clears badge | group transitions to pass | frame contains ✓ | No |
| Message with special chars | message with quotes | properly escaped in osascript args | Yes |

### Edge Cases Checklist
- [x] Empty message string → still dispatches (no crash)
- [x] Non-macOS (osascript missing) → degrades silently, returns false
- [x] Config missing notifications key → uses default (system: true)
- [x] Multiple groups transition simultaneously → each gets notification
- [x] Same step_result on consecutive polls → no duplicate notification
- [x] Group disappears between polls → no crash, ref cleaned up

---

## Validation Commands

### Static Analysis
```bash
pnpm run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm run test -- --run
```
EXPECT: All tests pass including new notification tests

### Build
```bash
pnpm run build
```
EXPECT: Clean build

### Lint
```bash
pnpm run check
```
EXPECT: No lint errors

---

## Acceptance Criteria
- [x] `notify(message, level)` dispatches to TUI badge update and system notification
- [ ] TUI badge: ⚠ icon appears next to PR group in dashboard when NEEDS_INPUT
- [ ] TUI badge: clears when issue is resolved or user takes over
- [ ] macOS notification sent for: NEEDS_INPUT, blocking errors, review cycle exhausted
- [ ] macOS notification NOT sent for: silent retries, transient failures
- [ ] System notifications disabled when `config.notifications.system` is false
- [ ] Handles error: `osascript` not available (non-macOS) — degrades silently, TUI badge still works
- [ ] Tests mock `osascript` execution and verify config toggle behavior

## Completion Checklist
- [ ] Code follows discovered patterns (functional modules, immutable state)
- [ ] Error handling matches codebase style (stderr logging, never throws)
- [ ] Tests follow test patterns (makeGroup factory, vitest, render/lastFrame)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| osascript behavior varies across macOS versions | Low | Low | Use basic `display notification` API, widely supported |
| Notification spam on rapid state transitions | Medium | Medium | Transition-based firing (ref diff) prevents duplicates per poll |
| execFile path resolution on different systems | Low | Low | Use bare `osascript` — on macOS it's always in PATH |

## Notes
- The ⚠ icon mapping for `needs-input` already exists in `getStatusIcon` — the TUI badge is mostly wiring existing logic into `PRGroupsPanel`
- The scheduler already sets `step_result` to error strings on failure — no scheduler changes needed
- `NotificationConfig` type and `DEFAULT_CONFIG.notifications` already exist — no config schema changes needed
- The `needs-input` step_result is not yet set by the scheduler — this will need a separate issue/PR to add NEEDS_INPUT detection in the worker event handler. For now, the notification service will be ready to react when it's set.
