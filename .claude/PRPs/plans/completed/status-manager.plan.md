# Plan: Status Manager

## Summary
Implement the Status Manager module for file-based state CRUD and context file lifecycle. Adds a `GroupStatus` type with full PRD-spec fields, atomic writes via temp-file-rename, context file CRUD, and a `reconcile()` function that cross-references status with git branch state.

## User Story
As the orchestrator scheduler, I want persistent file-based status tracking per PR group, so that work progress survives restarts and can be reconciled with git state.

## Problem → Solution
No structured state management exists beyond the lightweight `StatusEntry` read/display layer → Full CRUD with atomic writes, ephemeral context files, and git-state reconciliation.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (Issue #5)
- **PRD Phase**: N/A
- **Estimated Files**: 3 (types.ts update, status-manager.ts create, status-manager.test.ts create)

---

## UX Design

N/A — internal module, no user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts` | all | Existing types — add GroupStatus here |
| P0 | `src/status.ts` | all | Existing status read/display — don't duplicate |
| P0 | `src/config.ts` | 36-47 | Directory creation + write pattern |
| P0 | `src/lock.ts` | 35-42 | Atomic file write pattern (openSync 'ax') |
| P1 | `src/status.test.ts` | all | Test patterns for status files |
| P1 | `src/parser.ts` | 47-54 | Async file I/O pattern |
| P2 | `src/runtime.ts` | all | clearRuntimeState clears status/context dirs |

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/status.ts:9-11, src/config.ts:28-30
```typescript
export function getStatusDir(baseDir?: string): string {
    return path.resolve(baseDir ?? '.', '.orchestrator/status');
}
```
All path functions take optional `baseDir` parameter, default to `'.'`.

### ERROR_HANDLING
// SOURCE: src/config.ts:66-84
```typescript
// Three-layer: file read → JSON parse → shape validation
// Each layer throws with descriptive message
try { content = fs.readFileSync(...) } catch { throw new Error(`Failed to read...`) }
try { parsed = JSON.parse(content) } catch { throw new Error(`Invalid JSON...`) }
if (!validate(parsed)) { throw new Error(`Invalid shape...`) }
```

### VALIDATION_PATTERN
// SOURCE: src/status.ts:13-23
```typescript
function isValidStatusEntry(value: unknown): value is StatusEntry {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    return (typeof obj.slug === 'string' && ...);
}
```
Type guards return boolean, check all required fields.

### DIR_CREATION
// SOURCE: src/config.ts:43-44
```typescript
fs.mkdirSync(dir, { recursive: true });
```
Create directories with `recursive: true` on first write.

### TEST_STRUCTURE
// SOURCE: src/status.test.ts:8-16
```typescript
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-...-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
```

### IMPORT_CONVENTION
// SOURCE: all modules
```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Foo } from './types.js';
```
Use `node:` prefix, `.js` extension on relative imports, `import type` for types.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add GroupStatus, GroupStep, GitBranchState types |
| `src/status-manager.ts` | CREATE | New module: read, write, context CRUD, reconcile |
| `src/status-manager.test.ts` | CREATE | Tests for all operations |

## NOT Building

- TUI rendering of status (#11)
- Scheduler logic that triggers status updates (#9)
- Git operations / worktree management (#6)
- Modifying existing `status.ts` read/display functions
- Actual `gh` or `git` CLI calls — `reconcile` takes a `GitBranchState` input

---

## Step-by-Step Tasks

### Task 1: Add types to types.ts
- **ACTION**: Add `GroupStep`, `GroupStatus`, and `GitBranchState` types
- **IMPLEMENT**:
  ```typescript
  export type GroupStep = 'idle' | 'cloning' | 'coding' | 'verifying' | 'reviewing' | 'merging';

  export interface GroupStatus {
      readonly pr_group: string;
      readonly branch: string;
      readonly current_issue: number | null;
      readonly step: GroupStep;
      readonly step_result: string;
      readonly issues_completed: readonly number[];
      readonly issues_remaining: readonly number[];
      readonly blocked: boolean;
      readonly needs_input: boolean;
      readonly last_updated: string; // ISO 8601
  }

  export interface GitBranchState {
      readonly branches: readonly string[];
      readonly branchHasCommits: ReadonlyMap<string, boolean>;
  }
  ```
- **MIRROR**: NAMING_CONVENTION — readonly interfaces, literal union types
- **IMPORTS**: None needed
- **GOTCHA**: `last_updated` as ISO string (not Date) for JSON serialization
- **VALIDATE**: `pnpm run typecheck`

### Task 2: Create status-manager.ts — read/write with atomic writes
- **ACTION**: Create module with `readGroupStatus`, `writeGroupStatus` functions
- **IMPLEMENT**:
  - `getGroupStatusPath(groupSlug, baseDir?)` → `.orchestrator/status/<slug>.json`
  - `getContextDir(groupSlug, baseDir?)` → `.orchestrator/context/<slug>/`
  - `isValidGroupStatus(value)` — type guard checking all fields
  - `readGroupStatus(groupSlug, baseDir?)` → reads JSON, validates, returns `GroupStatus | null`
  - `writeGroupStatus(groupSlug, data, baseDir?)` → writes to temp file, renames atomically
  - Atomic write: `writeFileSync` to `<path>.tmp`, then `renameSync` to `<path>`
- **MIRROR**: VALIDATION_PATTERN, DIR_CREATION, ERROR_HANDLING
- **IMPORTS**: `node:fs`, `node:path`, `node:os`, types from `./types.js`
- **GOTCHA**: Use `fs.renameSync` for atomic move — works on same filesystem. Temp file must be in same directory as target for rename to be atomic.
- **VALIDATE**: `pnpm run typecheck`

### Task 3: Add context file CRUD to status-manager.ts
- **ACTION**: Add `writeContext`, `readContext`, `deleteContext` functions
- **IMPLEMENT**:
  - `writeContext(groupSlug, issue, content, baseDir?)` → writes to `.orchestrator/context/<slug>/<issue>.md`, creates dirs
  - `readContext(groupSlug, issue, baseDir?)` → returns string content or null
  - `deleteContext(groupSlug, issue, baseDir?)` → removes file, no-op if missing
- **MIRROR**: DIR_CREATION, ERROR_HANDLING
- **IMPORTS**: Same as Task 2
- **GOTCHA**: `deleteContext` should not throw if file doesn't exist — use try/catch around `unlinkSync`
- **VALIDATE**: `pnpm run typecheck`

### Task 4: Add reconcile function
- **ACTION**: Add `reconcile(gitState, baseDir?)` that reads all status files and corrects stale ones
- **IMPLEMENT**:
  - Read all `.json` files from status dir
  - For each valid GroupStatus:
    - If branch not in `gitState.branches` → mark step as `'idle'`, clear current_issue
    - If branch exists but `branchHasCommits` is false → reset to idle
  - Write corrected status back (using atomic write)
  - Return list of corrections made (for logging)
- **MIRROR**: VALIDATION_PATTERN (reuse isValidGroupStatus), DIR_CREATION
- **IMPORTS**: Same as Task 2
- **GOTCHA**: Don't delete status files — just correct stale data. Caller decides what to do with corrections.
- **VALIDATE**: `pnpm run typecheck`

### Task 5: Write tests — read/write/atomic
- **ACTION**: Create `status-manager.test.ts` with tests for read, write, atomic behavior
- **IMPLEMENT**:
  - Test `readGroupStatus` returns null for missing file
  - Test `readGroupStatus` returns null for invalid JSON
  - Test `readGroupStatus` returns validated GroupStatus
  - Test `writeGroupStatus` creates directories on first write
  - Test `writeGroupStatus` writes valid JSON that round-trips
  - Test atomic write (verify no `.tmp` file remains after write)
  - Test immutability — write doesn't mutate input
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `node:fs`, `node:os`, `node:path`, `vitest`, status-manager functions
- **VALIDATE**: `pnpm test`

### Task 6: Write tests — context CRUD
- **ACTION**: Add tests for writeContext, readContext, deleteContext
- **IMPLEMENT**:
  - Test `writeContext` creates file and directories
  - Test `readContext` returns content
  - Test `readContext` returns null for missing file
  - Test `deleteContext` removes file
  - Test `deleteContext` no-op for missing file
  - Test `writeContext` overwrites existing content
- **MIRROR**: TEST_STRUCTURE
- **VALIDATE**: `pnpm test`

### Task 7: Write tests — reconcile
- **ACTION**: Add tests for reconcile function
- **IMPLEMENT**:
  - Test reconcile with matching branch state (no changes)
  - Test reconcile corrects status when branch is missing
  - Test reconcile corrects status when branch has no commits
  - Test reconcile skips invalid status files
  - Test reconcile handles empty status directory
  - Test reconcile handles missing status directory
- **MIRROR**: TEST_STRUCTURE
- **VALIDATE**: `pnpm test`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| read missing file | nonexistent slug | null | Yes |
| read invalid JSON | malformed file | null | Yes |
| read valid status | well-formed JSON file | GroupStatus object | No |
| write creates dirs | first write to new dir | dir + file created | Yes |
| write atomic | any data | no .tmp residue | No |
| write round-trips | GroupStatus object | identical object from read | No |
| context write/read | slug + issue + content | matching content | No |
| context read missing | nonexistent file | null | Yes |
| context delete | existing file | file removed | No |
| context delete missing | nonexistent file | no error | Yes |
| reconcile no-op | matching git state | no corrections | No |
| reconcile stale branch | branch removed from git | status corrected to idle | No |
| reconcile no commits | branch exists, no commits | status corrected | No |

### Edge Cases Checklist
- [x] Missing file → return null
- [x] Missing directory → return null / create on write
- [x] Invalid JSON → return null (warn to stderr)
- [x] Invalid shape → return null (warn to stderr)
- [x] Delete nonexistent → no-op
- [x] Atomic write leaves no temp file
- [x] Reconcile with empty dir

---

## Validation Commands

### Static Analysis
```bash
npx tsc --noEmit
```
EXPECT: Zero type errors

### Lint
```bash
pnpm check
```
EXPECT: No lint issues

### Unit Tests
```bash
pnpm test
```
EXPECT: All tests pass

### Build
```bash
pnpm build
```
EXPECT: Clean build

---

## Acceptance Criteria
- [ ] `readGroupStatus(groupSlug)` returns typed status object or null if not found
- [ ] `writeGroupStatus(groupSlug, data)` atomically writes status JSON (write to temp file, rename)
- [ ] Status JSON shape matches PRD spec fields
- [ ] `writeContext(groupSlug, issue, content)` creates/updates ephemeral context file
- [ ] `readContext(groupSlug, issue)` returns context content or null
- [ ] `deleteContext(groupSlug, issue)` removes context file
- [ ] `reconcile(gitState)` cross-references status files with git branch state and corrects stale status
- [ ] Creates `.orchestrator/status/` and `.orchestrator/context/` directories on first write
- [ ] All operations are immutable — returns new objects, never mutates input
- [ ] Tests against temp filesystem verify read/write/delete/reconcile

## Completion Checklist
- [ ] Code follows discovered patterns (baseDir param, type guards, sync I/O)
- [ ] Error handling: stderr warnings for malformed files, throws for unexpected errors
- [ ] Tests follow test patterns (tmpDir setup/teardown)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rename not atomic across filesystems | Low | Medium | Temp file in same dir as target |
| Existing StatusEntry vs GroupStatus confusion | Medium | Low | Different function names, clear types |

## Notes
- Existing `status.ts` (readStatusFiles, formatStatus, printStatus) stays untouched — it reads the lightweight StatusEntry format for CLI display. The new `status-manager.ts` handles the richer GroupStatus for the scheduler.
- `reconcile` takes a `GitBranchState` parameter rather than calling git directly — keeps the module testable and decoupled from #6 (Worktree Manager).
- Using sync I/O to match the majority of the codebase (only parser.ts uses async). Status manager operations are fast local file I/O — no benefit from async.
