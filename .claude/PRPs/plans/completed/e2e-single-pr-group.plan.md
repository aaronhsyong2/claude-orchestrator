# Plan: End-to-end single PR group flow (console output)

## Summary
Wire Scheduler + Worker Manager + Worktree Manager + Verification Pipeline + Status Manager together in `cli.tsx` so `orchestrator start plan.md` processes one PR group end-to-end with console progress output. Add integration test with mock `claude -p` subprocess.

## User Story
As an orchestrator user, I want to run `orchestrator start plan.md` and see it process a PR group from start to finish with console progress, so that the core loop is proven before adding TUI.

## Problem -> Solution
CLI `start` command currently prints "Scheduler not yet implemented" -> Wire all modules, print progress lines, run scheduler loop to completion.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 3 (1 update, 1 create, 1 update test)
- **Issue**: #10

---

## UX Design

### Before
```
$ orchestrator start plan.md
Acquired lock (.orchestrator/lock, PID 12345)
Orchestrator started. Scheduler not yet implemented (see Issue #9).
```

### After
```
$ orchestrator start plan.md
Acquired lock (.orchestrator/lock, PID 12345)
Starting PR 1: Type Cleanup [feat/type-cleanup]
  Issue #30: implementing...
  Issue #30: verifying...
  Issue #30: done
  Issue #31: implementing...
  Issue #31: verifying...
  Issue #31: done
PR group ready for review: PR 1 [feat/type-cleanup]
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `orchestrator start` | Exits immediately with stub message | Runs scheduler loop, prints progress, exits when complete | Blocks until group finishes |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/cli.tsx` | 38-65 | handleStart — where wiring goes |
| P0 | `src/scheduler.ts` | 219-262 | assignWork + onMerge — the loop entry points |
| P0 | `src/scheduler.ts` | 46-168 | processIssue — step lifecycle to map progress lines |
| P0 | `src/types.ts` | 113-144 | SchedulerDeps + AssignWorkResult — interface contract |
| P1 | `src/worker-manager.ts` | 76-177 | spawnWorker — how workers are created |
| P1 | `src/worktree-manager.ts` | 1-141 | create/remove — worktree lifecycle |
| P1 | `src/verification.ts` | 1-74 | verify — command runner |
| P1 | `src/status-manager.ts` | 1-189 | read/write GroupStatus, context ops |
| P1 | `src/parser.ts` | 1-206 | parsePlan — plan file parsing |
| P1 | `src/config.ts` | 1-97 | loadConfig — config loading |
| P2 | `src/lock.ts` | 1-90 | acquireLock/releaseLock — lock lifecycle |
| P2 | `src/cli.test.ts` | 1-135 | Existing CLI test patterns |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| N/A | N/A | No external research needed — feature uses established internal patterns |

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/cli.tsx:38
```typescript
async function handleStart(args: readonly string[]): Promise<void> {
```
Functions: camelCase. Files: kebab-case. Types: PascalCase.

### ERROR_HANDLING
// SOURCE: src/cli.tsx:90-94
```typescript
main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
});
```

### CONSOLE_OUTPUT
// SOURCE: src/cli.tsx:61,64
```typescript
process.stdout.write(`Acquired lock (.orchestrator/lock, PID ${process.pid})\n`);
process.stdout.write('Orchestrator started. Scheduler not yet implemented (see Issue #9).\n');
```
Use `process.stdout.write()` for user output, `process.stderr.write()` for errors.

### SCHEDULER_DEPS_WIRING
// SOURCE: src/types.ts:115-131
```typescript
interface SchedulerDeps {
	readonly createWorktree: (branch: string, baseBranch?: string) => WorktreeInfo;
	readonly removeWorktree: (branch: string) => void;
	readonly spawnWorker: (...) => WorkerHandle;
	readonly killWorker: (pid: number) => Promise<void>;
	readonly verify: (cwd: string, commands: readonly VerifyCommand[]) => Promise<VerifyResult>;
	readonly readGroupStatus: (groupSlug: string) => GroupStatus | null;
	readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
	readonly readContext: (groupSlug: string, issue: string) => string | null;
	readonly deleteContext: (groupSlug: string, issue: string) => void;
}
```

### IMMUTABLE_STATE_UPDATE
// SOURCE: src/scheduler.ts:55-62
```typescript
deps.writeGroupStatus(slug, {
	...freshStatus(slug, group, deps, now),
	current_issue: issueNumber,
	step: 'cloning',
	step_result: '',
	last_updated: now(),
});
```

### TEST_STRUCTURE
// SOURCE: src/cli.test.ts:20-39
```typescript
function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync('node', [CLI_PATH, ...args], {
			cwd: tmpDir,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return { stdout, stderr: '', exitCode: 0 };
	} catch (error: unknown) { ... }
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/cli.tsx` | UPDATE | Wire handleStart to scheduler, add progress callbacks |
| `src/orchestrate.ts` | CREATE | Orchestration function that builds deps, calls assignWork, handles progress |
| `src/orchestrate.test.ts` | CREATE | Integration test with mock claude subprocess |
| `src/cli.test.ts` | UPDATE | Update existing start tests for new behavior |

## NOT Building

- TUI dashboard (Issue #11)
- Multi-group concurrent execution focus (tested in scheduler, but not the E2E focus)
- Review pipeline (Issues #16, #17)
- Retry logic (Issue #15)
- GitHub issue fetcher / enrichWithBlockedBy (plan file has all needed data)
- onMerge webhook integration

---

## Step-by-Step Tasks

### Task 1: Create orchestrate.ts — the wiring function
- **ACTION**: Create `src/orchestrate.ts` with a function that builds SchedulerDeps from real modules and calls assignWork
- **IMPLEMENT**:
  ```typescript
  import { loadConfig } from './config.js';
  import { parsePlan } from './parser.js';
  import { assignWork } from './scheduler.js';
  import { readGroupStatus, writeGroupStatus, readContext, deleteContext } from './status-manager.js';
  import { verify } from './verification.js';
  import { spawnWorker, killWorker } from './worker-manager.js';
  import { create, remove } from './worktree-manager.js';
  import type { SchedulerDeps, AssignWorkResult, GroupStatus } from './types.js';

  export type ProgressCallback = (message: string) => void;

  export async function orchestrate(
    planPath: string,
    onProgress: ProgressCallback,
  ): Promise<AssignWorkResult> {
    const config = loadConfig();
    const plan = await parsePlan(planPath);

    // Log group info
    for (const group of plan.groups) {
      onProgress(`Starting PR ${group.pr_number}: ${group.title} [${group.branch}]`);
    }

    // Build real deps with progress-reporting wrappers
    const deps: SchedulerDeps = {
      createWorktree: (branch, baseBranch) => create(branch, baseBranch),
      removeWorktree: (branch) => remove(branch),
      spawnWorker: (issue, groupSlug, worktreePath, onEvent, context) => {
        onProgress(`  Issue #${issue}: implementing...`);
        return spawnWorker(issue, groupSlug, worktreePath, (event, data) => {
          if (event === 'exited' && data === 0) {
            // Worker succeeded — verification will be next
          }
          onEvent(event, data);
        }, context);
      },
      killWorker,
      verify: async (cwd, commands) => {
        // Find which issue is being verified from status files
        onProgress(`  verifying...`);
        const result = await verify(cwd, commands);
        return result;
      },
      readGroupStatus,
      writeGroupStatus: (slug, data) => {
        writeGroupStatus(slug, data);
        // Emit progress on state transitions
        if (data.step === 'verifying' && data.current_issue !== null) {
          onProgress(`  Issue #${data.current_issue}: verifying...`);
        }
        if (data.step === 'idle' && data.step_result === 'pass' && data.current_issue === null) {
          // Issue just completed — find which one from issues_completed
          const last = data.issues_completed[data.issues_completed.length - 1];
          if (last !== undefined) {
            onProgress(`  Issue #${last}: done`);
          }
        }
        if (data.step === 'reviewing') {
          onProgress(`PR group ready for review: ${slug}`);
        }
      },
      readContext,
      deleteContext,
    };

    const mergedPRs = new Set<number>();
    const result = await assignWork(plan, mergedPRs, config, deps);
    return result;
  }
  ```
- **MIRROR**: SCHEDULER_DEPS_WIRING, CONSOLE_OUTPUT
- **IMPORTS**: All module imports listed above
- **GOTCHA**: `writeGroupStatus` wrapper must call the real `writeGroupStatus` first, then emit progress. The scheduler calls `writeGroupStatus` frequently — only emit progress on meaningful transitions (step changes), not every write. Use the step field to determine which transitions to log.
- **GOTCHA**: The spawnWorker wrapper should emit "implementing..." when the worker is spawned, not on every event. The scheduler already handles the `coding` step status write.
- **GOTCHA**: Progress for "verifying" comes from the writeGroupStatus wrapper detecting `step === 'verifying'`, not from the verify wrapper — the scheduler sets step before calling verify.
- **VALIDATE**: TypeScript compiles. Function signature matches what cli.tsx needs.

### Task 2: Refine progress emission to avoid duplicates
- **ACTION**: Review Task 1 implementation — progress should come from ONE place per transition. The writeGroupStatus wrapper is the single source of truth for state transitions.
- **IMPLEMENT**: Remove progress from spawnWorker and verify wrappers. Instead, detect all transitions in writeGroupStatus:
  ```typescript
  writeGroupStatus: (slug, data) => {
    writeGroupStatus(slug, data);
    if (data.current_issue !== null) {
      if (data.step === 'coding') {
        onProgress(`  Issue #${data.current_issue}: implementing...`);
      } else if (data.step === 'verifying') {
        onProgress(`  Issue #${data.current_issue}: verifying...`);
      }
    }
    if (data.step === 'idle' && data.step_result === 'pass') {
      const last = data.issues_completed[data.issues_completed.length - 1];
      if (last !== undefined) {
        onProgress(`  Issue #${last}: done`);
      }
    }
    if (data.step === 'reviewing') {
      onProgress(`PR group ready for review: ${slug}`);
    }
  },
  ```
- **MIRROR**: IMMUTABLE_STATE_UPDATE
- **GOTCHA**: The `cloning` step also writes to status but we don't need to log it separately — it's implicit before "implementing". Keep progress lines minimal per acceptance criteria.
- **VALIDATE**: Each issue produces exactly: "implementing..." → "verifying..." → "done"

### Task 3: Update cli.tsx handleStart
- **ACTION**: Replace stub in handleStart with call to `orchestrate()`
- **IMPLEMENT**:
  ```typescript
  import { releaseLock } from './lock.js';
  import { orchestrate } from './orchestrate.js';

  async function handleStart(args: readonly string[]): Promise<void> {
    // ... existing arg parsing, --fresh, lock acquisition ...

    try {
      await orchestrate(planPath, (msg) => process.stdout.write(`${msg}\n`));
    } finally {
      releaseLock();
    }
  }
  ```
- **MIRROR**: ERROR_HANDLING, CONSOLE_OUTPUT
- **IMPORTS**: `orchestrate` from `./orchestrate.js`, `releaseLock` from `./lock.js`
- **GOTCHA**: handleStart must become `async`. Main already handles async via `.catch()`.
- **GOTCHA**: releaseLock in `finally` — signal handlers also call releaseLock, which is idempotent (ENOENT-safe).
- **GOTCHA**: Remove the old stub line: `process.stdout.write('Orchestrator started. Scheduler not yet implemented (see Issue #9).\n');`
- **VALIDATE**: `orchestrator start plan.md` runs, prints progress, exits cleanly.

### Task 4: Update cli.test.ts for new start behavior
- **ACTION**: Update existing `start` tests — the start command now runs orchestration instead of printing stub
- **IMPLEMENT**: The existing tests check for "Acquired lock" and "--fresh" behavior. These still apply. Update:
  - Remove expectation for "Scheduler not yet implemented" message
  - The `acquires lock with valid plan file` test needs a valid plan file format that parsePlan can handle, but the test will fail at scheduler (no worktree, no claude binary) — test should expect non-zero exit or catch the error
  - Keep the test simple: verify that a plan file with no groups completes cleanly
  ```typescript
  it('completes with empty plan', () => {
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Empty Plan\n');
    const result = run('start', 'plan.md');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Acquired lock');
  });
  ```
- **MIRROR**: TEST_STRUCTURE
- **GOTCHA**: Existing tests run the built CLI via `node dist/cli.js` — must rebuild before running. Test timeout is 5000ms.
- **GOTCHA**: A plan with no PR groups results in `assignWork` returning `{ assigned: 0, results: [] }` — exits cleanly with no progress lines.
- **VALIDATE**: `pnpm test -- --run src/cli.test.ts` passes.

### Task 5: Create orchestrate.test.ts — integration test with mock subprocess
- **ACTION**: Create `src/orchestrate.test.ts` with integration tests that mock the subprocess (not the full `claude` binary, but the SchedulerDeps)
- **IMPLEMENT**: Test the orchestrate function by:
  1. Creating a temp dir with a valid plan file
  2. Mocking the modules that orchestrate imports (vi.mock)
  3. Verifying progress messages are emitted in correct order
  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import * as fs from 'node:fs';
  import * as os from 'node:os';
  import * as path from 'node:path';

  // Test with a plan file that has one group with two issues
  // Mock all external deps (config, parser, scheduler modules)
  // Verify progress callback receives messages in order:
  //   "Starting PR 1: ..."
  //   "Issue #30: implementing..."
  //   "Issue #30: verifying..."
  //   "Issue #30: done"
  //   "PR group ready for review: ..."
  ```
- **MIRROR**: TEST_STRUCTURE
- **GOTCHA**: vi.mock hoists — mock at module level, configure per test. The orchestrate function imports many modules; mock each one.
- **GOTCHA**: Alternative approach — instead of mocking modules, extract deps-building into a separate function and test with injected deps. This avoids brittle module mocking.
- **VALIDATE**: `pnpm test -- --run src/orchestrate.test.ts` passes.

### Task 6: Refactor orchestrate.ts for testability
- **ACTION**: Make deps injectable so integration test doesn't need module mocking
- **IMPLEMENT**: Accept optional deps parameter:
  ```typescript
  export async function orchestrate(
    planPath: string,
    onProgress: ProgressCallback,
    overrides?: Partial<{
      loadConfig: () => OrchestratorConfig;
      parsePlan: (path: string) => Promise<PlanData>;
      deps: SchedulerDeps;
    }>,
  ): Promise<AssignWorkResult> {
    const config = (overrides?.loadConfig ?? realLoadConfig)();
    const plan = await (overrides?.parsePlan ?? realParsePlan)(planPath);
    // ... build deps or use overrides.deps ...
  }
  ```
- **MIRROR**: NAMING_CONVENTION
- **GOTCHA**: Keep the overrides parameter optional — production path calls with no overrides. Only tests inject mocks.
- **VALIDATE**: Production behavior unchanged. Tests can inject mock deps.

### Task 7: Write full integration test
- **ACTION**: Write comprehensive integration test using injected deps
- **IMPLEMENT**:
  ```typescript
  describe('orchestrate', () => {
    it('processes one PR group end-to-end with progress', async () => {
      const plan: PlanData = {
        title: 'Test Plan',
        groups: [{
          pr_number: 1,
          title: 'Type Cleanup',
          branch: 'feat/type-cleanup',
          status: 'pending',
          issues: [
            { number: 30, title: 'Fix types', status: 'open', blocked_by: [] },
            { number: 31, title: 'Add tests', status: 'open', blocked_by: [30] },
          ],
          depends_on: [],
        }],
      };

      const progress: string[] = [];
      const statusWrites: GroupStatus[] = [];

      const mockDeps: SchedulerDeps = {
        createWorktree: vi.fn().mockReturnValue({
          branch: 'feat/type-cleanup',
          worktreePath: '/tmp/mock-worktree',
        }),
        removeWorktree: vi.fn(),
        spawnWorker: vi.fn().mockImplementation(
          (_issue, _slug, _path, onEvent) => {
            process.nextTick(() => onEvent('spawned', 0));
            process.nextTick(() => onEvent('exited', 0));
            return { id: 'mock', issue: _issue, groupSlug: _slug, pid: 999 };
          },
        ),
        killWorker: vi.fn(),
        verify: vi.fn().mockResolvedValue({ success: true, steps: [] }),
        readGroupStatus: vi.fn().mockReturnValue(null),
        writeGroupStatus: vi.fn().mockImplementation((_slug, data) => {
          statusWrites.push(data);
        }),
        readContext: vi.fn().mockReturnValue(null),
        deleteContext: vi.fn(),
      };

      // ... call orchestrate with mock plan and deps
      // Assert progress messages contain expected lines
      // Assert both issues processed
      // Assert "PR group ready for review" appears
    });
  });
  ```
- **MIRROR**: TEST_STRUCTURE, SCHEDULER_DEPS_WIRING
- **GOTCHA**: The `readGroupStatus` mock needs to return the latest write — either use a closure over statusWrites or implement a simple in-memory store.
- **GOTCHA**: spawnWorker mock must call onEvent asynchronously (via process.nextTick) to match real behavior.
- **VALIDATE**: Test passes and verifies all 8 acceptance criteria.

### Task 8: Verify full pipeline
- **ACTION**: Run all validation commands
- **VALIDATE**: `pnpm run check && pnpm run typecheck && pnpm run build && pnpm test -- --run`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Empty plan completes | Plan with no groups | `{ assigned: 0, results: [] }`, no progress | Yes |
| Single group, single issue | 1 group, 1 issue | Progress: implementing → verifying → done → ready | No |
| Single group, two issues | 1 group, 2 issues | Both issues processed serially | No |
| Worker failure | spawnWorker exits code 1 | Error result, progress stops | Yes |
| Verify failure | verify returns `{ success: false }` | Error result, progress stops | Yes |
| Worktree creation failure | createWorktree throws | Error result | Yes |

### Edge Cases Checklist
- [x] Empty input (plan with no groups)
- [x] Worker exit code non-zero
- [x] Verification failure
- [x] Worktree creation failure
- [ ] Concurrent access — N/A for single PR group focus
- [ ] Network failure — N/A (no network calls in this scope)

---

## Validation Commands

### Static Analysis
```bash
pnpm run check
```
EXPECT: Zero lint errors

### Type Check
```bash
pnpm run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm test -- --run
```
EXPECT: All tests pass

### Build
```bash
pnpm run build
```
EXPECT: Clean build, dist/cli.js produced

### Manual Validation
- [ ] Run `orchestrator init` in a temp dir
- [ ] Run `orchestrator start plan.md` with a minimal plan (will fail at real claude spawn, but should show progress structure)
- [ ] Run `orchestrator status` in another terminal while running

---

## Acceptance Criteria
- [ ] `orchestrator start plan.md` processes one PR group end-to-end
- [ ] Worktree created with correct branch name from plan
- [ ] Each issue spawns `claude -p` with `/pick-up` prompt
- [ ] Each issue verification runs after commit
- [ ] Status files update in real-time (observable via `orchestrator status`)
- [ ] Console prints progress per issue (implementing, verifying, done)
- [ ] On all issues complete: prints "PR group ready for review"
- [ ] Integration test with mock `claude -p` verifies full flow

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Tests follow test patterns
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Progress messages duplicated due to multiple writeGroupStatus calls | Medium | Low | Single source of truth: only writeGroupStatus wrapper emits progress |
| readGroupStatus mock doesn't track writes, causing scheduler to re-process issues | High | High | Implement in-memory store in mock that returns latest write |
| Integration test timing — nextTick ordering of spawnWorker events | Low | Medium | Use deterministic event ordering in mock |

## Notes
- The scheduler already handles the full lifecycle (cloning → coding → verifying → reviewing). This issue is purely about **wiring** it to real modules and adding console output.
- Progress reporting is done by wrapping `writeGroupStatus` — the scheduler's existing state machine drives the progress transitions.
- The `orchestrate` function is kept thin — it's a composition layer, not new logic.
- `releaseLock` in `finally` block ensures cleanup even on errors. Signal handlers (already installed) also call `releaseLock`.
