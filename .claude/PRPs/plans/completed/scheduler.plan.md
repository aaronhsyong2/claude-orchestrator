# Plan: Scheduler — Dependency-Aware Work Assignment

## Summary

Implement the Scheduler module — the core orchestration brain that reads parsed PR plan data, determines which PR groups are ready (all cross-group dependencies merged), and assigns workers up to `max_concurrent_agents`. Within each group, issues execute serially in topological order. Coordinates the full per-issue lifecycle: worktree creation → worker spawn → verify → advance. Updates status files at each state transition.

## User Story

As an orchestrator operator,
I want the scheduler to automatically assign work based on dependency readiness and concurrency limits,
So that PR groups are processed efficiently without manual coordination.

## Problem → Solution

No scheduling logic exists — individual modules (parser, worker, worktree, verify, status) are disconnected → A Scheduler module wires them together, driving the full lifecycle from "group ready" to "group complete."

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 2 (scheduler.ts + scheduler.test.ts)
- **GitHub Issue**: #9

---

## UX Design

N/A — internal change. No user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts` | 1-142 | All shared types: PlanData, PRGroup, GroupStatus, WorkerHandle, OrchestratorConfig |
| P0 | `src/status-manager.ts` | 1-189 | State CRUD — writeGroupStatus, readGroupStatus, deleteContext, readContext |
| P0 | `src/worker-manager.ts` | 76-177 | spawnWorker signature, WorkerEventCallback, WorkerHandle |
| P0 | `src/worktree-manager.ts` | 66-116 | create() returns WorktreeInfo, idempotent |
| P0 | `src/verification.ts` | 15-42 | verify() returns VerifyResult with success/failedStep |
| P1 | `src/graph.ts` | 1-74 | buildDependencyGraph — topological sort for group ordering |
| P1 | `src/config.ts` | 6-26 | DEFAULT_CONFIG shape, max_concurrent_agents field |
| P1 | `src/parser.ts` | 48-156 | parsePlan returns PlanData, enrichWithBlockedBy for issue deps |
| P2 | `src/validation.ts` | 1-14 | assertValidSlug, assertValidIssue |

## External Documentation

No external research needed — feature uses established internal patterns.

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/worker-manager.ts:76, src/worktree-manager.ts:66, src/verification.ts:15
// Functions: camelCase, exported at module level (no class wrappers)
// Files: kebab-case.ts with co-located kebab-case.test.ts
// Types: PascalCase interfaces in types.ts, readonly fields
export function spawnWorker(issue: string, groupSlug: string, ...): WorkerHandle
export function create(branch: string, baseBranch?: string, baseDir?: string): WorktreeInfo
export async function verify(cwd: string, commands: readonly VerifyCommand[]): Promise<VerifyResult>
```

### ERROR_HANDLING
```typescript
// SOURCE: src/worktree-manager.ts:88-112
// Pattern: descriptive Error messages, specific checks for known failure modes
if (message.includes('No space left on device') || message.includes('Disk quota exceeded')) {
	throw new Error(`Disk full — cannot create worktree at ${wtPath}`);
}
```

### IMMUTABILITY_PATTERN
```typescript
// SOURCE: src/status-manager.ts:162-168
// Pattern: spread operator for state updates, never mutate input
const corrected: GroupStatus = {
	...parsed,
	step: 'idle',
	current_issue: null,
	step_result: '',
	last_updated: now(),
};
```

### STATUS_UPDATE_PATTERN
```typescript
// SOURCE: src/status-manager.ts:66-75
// Pattern: assertValidSlug → build path → mkdirSync → atomic write (tmp + rename)
export function writeGroupStatus(groupSlug: string, data: GroupStatus, baseDir?: string): void {
	assertValidSlug(groupSlug);
	const filePath = getGroupStatusPath(groupSlug, baseDir);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, '\t')}\n`);
	fs.renameSync(tmpPath, filePath);
}
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/worker-manager.test.ts:1-35, src/verification.test.ts:1-38
// Pattern: vi.mock at top, mocked references, tmpDir with beforeEach/afterEach cleanup
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn() };
});
const spawnMock = vi.mocked(childProcess.spawn);

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scheduler-'));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});
```

### SLUG_DERIVATION
```typescript
// SOURCE: src/worktree-manager.ts:43-53
// Branch name → slug: lowercase, replace non-alphanumeric with hyphens
const slug = branch.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/scheduler.ts` | CREATE | Core scheduling module with all orchestration logic |
| `src/scheduler.test.ts` | CREATE | Tests covering all acceptance criteria |
| `src/types.ts` | UPDATE | Add SchedulerDeps interface for dependency injection |

## NOT Building

- TUI rendering (that's #11)
- Retry/escalation logic details (that's #15) — on verify fail, scheduler calls a callback/delegate
- Self-review/PR review (that's #16, #17) — on group complete, scheduler signals "ready for review"
- Shutdown/resume (that's #18)
- Lock management — already handled in cli.tsx

---

## Step-by-Step Tasks

### Task 1: Add SchedulerDeps type to types.ts

- **ACTION**: Add a dependency injection interface so Scheduler can be tested with mocks
- **IMPLEMENT**:
  ```typescript
  export interface SchedulerDeps {
    readonly createWorktree: (branch: string, baseBranch?: string) => WorktreeInfo;
    readonly removeWorktree: (branch: string) => void;
    readonly spawnWorker: (
      issue: string,
      groupSlug: string,
      worktreePath: string,
      onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
      contextContent?: string,
    ) => WorkerHandle;
    readonly killWorker: (pid: number) => Promise<void>;
    readonly verify: (cwd: string, commands: readonly VerifyCommand[]) => Promise<VerifyResult>;
    readonly readGroupStatus: (groupSlug: string) => GroupStatus | null;
    readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
    readonly readContext: (groupSlug: string, issue: string) => string | null;
    readonly deleteContext: (groupSlug: string, issue: string) => void;
  }
  ```
- **MIRROR**: NAMING_CONVENTION — PascalCase interface, readonly fields, matches existing function signatures
- **IMPORTS**: All types already in types.ts
- **GOTCHA**: Keep readonly on all fields. Match exact function signatures from existing modules.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create scheduler.ts — getReadyGroups

- **ACTION**: Implement function to find PR groups with all cross-group dependencies satisfied
- **IMPLEMENT**:
  ```typescript
  export function getReadyGroups(
    plan: PlanData,
    mergedPRs: ReadonlySet<number>,
  ): readonly PRGroup[] {
    return plan.groups.filter((group) => {
      if (group.status === 'done' || group.status === 'merged') return false;
      return group.depends_on.every((dep) => mergedPRs.has(dep));
    });
  }
  ```
- **MIRROR**: NAMING_CONVENTION — exported function, camelCase, readonly return type
- **IMPORTS**: `import type { PlanData, PRGroup } from './types.js';`
- **GOTCHA**: Use ReadonlySet not Set for immutability. Filter out already-done/merged groups.
- **VALIDATE**: Unit test with groups having various dependency states

### Task 3: Create scheduler.ts — deriveGroupSlug helper

- **ACTION**: Convert branch name to slug (same logic as worktree-manager) for status file keys
- **IMPLEMENT**:
  ```typescript
  function deriveGroupSlug(branch: string): string {
    const slug = branch.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error(`Branch "${branch}" produces an empty slug`);
    return slug;
  }
  ```
- **MIRROR**: SLUG_DERIVATION — exact same regex as worktree-manager.ts:45-48
- **IMPORTS**: None
- **GOTCHA**: Must match worktree-manager slug derivation exactly or status/worktree paths diverge
- **VALIDATE**: Test with branches like `feat/scheduler-e2e`, `feat-scheduler-e2e`

### Task 4: Create scheduler.ts — initGroupStatus helper

- **ACTION**: Create initial GroupStatus for a group starting work
- **IMPLEMENT**:
  ```typescript
  function initGroupStatus(
    group: PRGroup,
    slug: string,
    now: () => string = () => new Date().toISOString(),
  ): GroupStatus {
    return {
      pr_group: slug,
      branch: group.branch,
      current_issue: null,
      step: 'idle',
      step_result: '',
      issues_completed: [],
      issues_remaining: group.issues.map((i) => i.number),
      blocked: false,
      needs_input: false,
      last_updated: now(),
    };
  }
  ```
- **MIRROR**: IMMUTABILITY_PATTERN — pure function returning new object
- **IMPORTS**: `import type { GroupStatus, PRGroup } from './types.js';`
- **GOTCHA**: issues_remaining must be in correct topological order (use issue order from plan, which is already dependency-ordered per issue spec)
- **VALIDATE**: Test returns correct shape

### Task 5: Create scheduler.ts — processIssue (core per-issue lifecycle)

- **ACTION**: Implement the per-issue lifecycle: update status → create worktree → spawn worker → wait for exit → verify → update status
- **IMPLEMENT**:
  ```typescript
  async function processIssue(
    group: PRGroup,
    issueNumber: number,
    slug: string,
    config: OrchestratorConfig,
    deps: SchedulerDeps,
    now: () => string = () => new Date().toISOString(),
  ): Promise<{ success: boolean; error?: string }> {
    // 1. Update status → cloning
    const currentStatus = deps.readGroupStatus(slug) ?? initGroupStatus(group, slug, now);
    deps.writeGroupStatus(slug, {
      ...currentStatus,
      current_issue: issueNumber,
      step: 'cloning',
      step_result: '',
      last_updated: now(),
    });

    // 2. Create worktree
    const worktreeInfo = deps.createWorktree(group.branch, config.base_branch);

    // 3. Read context (from previous attempt, if any)
    const contextContent = deps.readContext(slug, String(issueNumber)) ?? undefined;

    // 4. Update status → coding
    deps.writeGroupStatus(slug, {
      ...currentStatus,
      current_issue: issueNumber,
      step: 'coding',
      step_result: '',
      last_updated: now(),
    });

    // 5. Spawn worker and wait for exit
    const exitCode = await new Promise<number>((resolve, reject) => {
      try {
        deps.spawnWorker(
          String(issueNumber),
          slug,
          worktreeInfo.worktreePath,
          (event, data) => {
            if (event === 'exited') resolve(data as number);
            if (event === 'error') reject(data as Error);
          },
          contextContent,
        );
      } catch (err) {
        reject(err);
      }
    });

    if (exitCode !== 0) {
      deps.writeGroupStatus(slug, {
        ...currentStatus,
        current_issue: issueNumber,
        step: 'coding',
        step_result: `worker exited with code ${exitCode}`,
        last_updated: now(),
      });
      return { success: false, error: `worker exited with code ${exitCode}` };
    }

    // 6. Update status → verifying
    deps.writeGroupStatus(slug, {
      ...currentStatus,
      current_issue: issueNumber,
      step: 'verifying',
      step_result: '',
      last_updated: now(),
    });

    // 7. Run verification
    const verifyResult = await deps.verify(worktreeInfo.worktreePath, config.verify);

    if (!verifyResult.success) {
      deps.writeGroupStatus(slug, {
        ...currentStatus,
        current_issue: issueNumber,
        step: 'verifying',
        step_result: `failed: ${verifyResult.failedStep}`,
        last_updated: now(),
      });
      return { success: false, error: `verification failed at step: ${verifyResult.failedStep}` };
    }

    // 8. Success — delete context, update completed list
    deps.deleteContext(slug, String(issueNumber));
    const updatedStatus = deps.readGroupStatus(slug) ?? currentStatus;
    deps.writeGroupStatus(slug, {
      ...updatedStatus,
      current_issue: null,
      step: 'idle',
      step_result: 'pass',
      issues_completed: [...updatedStatus.issues_completed, issueNumber],
      issues_remaining: updatedStatus.issues_remaining.filter((n) => n !== issueNumber),
      last_updated: now(),
    });

    return { success: true };
  }
  ```
- **MIRROR**: IMMUTABILITY_PATTERN (spread for status updates), STATUS_UPDATE_PATTERN, ERROR_HANDLING
- **IMPORTS**: types.ts types
- **GOTCHA**: Worker exit via Promise wrapper — must handle both 'exited' and 'error' events. Re-read status before final update since time may have passed.
- **VALIDATE**: Test with mock deps: success path, worker failure path, verify failure path

### Task 6: Create scheduler.ts — processGroup (serial issue execution within group)

- **ACTION**: Process all issues in a group serially in order
- **IMPLEMENT**:
  ```typescript
  async function processGroup(
    group: PRGroup,
    config: OrchestratorConfig,
    deps: SchedulerDeps,
    now: () => string = () => new Date().toISOString(),
  ): Promise<{ completed: boolean; failedIssue?: number; error?: string }> {
    const slug = deriveGroupSlug(group.branch);

    // Initialize status if not exists
    const existing = deps.readGroupStatus(slug);
    if (!existing) {
      deps.writeGroupStatus(slug, initGroupStatus(group, slug, now));
    }

    // Process issues in order (issues_remaining from status, or plan order)
    const status = deps.readGroupStatus(slug)!;
    const remaining = status.issues_remaining;

    for (const issueNumber of remaining) {
      const result = await processIssue(group, issueNumber, slug, config, deps, now);
      if (!result.success) {
        return { completed: false, failedIssue: issueNumber, error: result.error };
      }
    }

    // All issues complete — signal ready for review
    const finalStatus = deps.readGroupStatus(slug)!;
    deps.writeGroupStatus(slug, {
      ...finalStatus,
      step: 'reviewing',
      step_result: 'ready for self-review',
      last_updated: now(),
    });

    return { completed: true };
  }
  ```
- **MIRROR**: IMMUTABILITY_PATTERN
- **IMPORTS**: types.ts
- **GOTCHA**: Read issues_remaining from status (not plan) so resumed runs skip completed issues
- **VALIDATE**: Test serial execution order, early exit on failure

### Task 7: Create scheduler.ts — assignWork (main scheduling loop)

- **ACTION**: Main loop: find ready groups, respect concurrency cap, process groups
- **IMPLEMENT**:
  ```typescript
  export async function assignWork(
    plan: PlanData,
    mergedPRs: ReadonlySet<number>,
    config: OrchestratorConfig,
    deps: SchedulerDeps,
    now: () => string = () => new Date().toISOString(),
  ): Promise<AssignWorkResult> {
    const ready = getReadyGroups(plan, mergedPRs);

    if (ready.length === 0) {
      return { assigned: 0, results: [] };
    }

    // Cap to max_concurrent_agents
    const toAssign = ready.slice(0, config.max_concurrent_agents);

    // Process groups concurrently (up to cap)
    const results = await Promise.all(
      toAssign.map((group) => processGroup(group, config, deps, now)),
    );

    return {
      assigned: toAssign.length,
      results: toAssign.map((group, i) => ({
        pr_number: group.pr_number,
        branch: group.branch,
        ...results[i],
      })),
    };
  }
  ```
- **MIRROR**: NAMING_CONVENTION
- **IMPORTS**: types from types.ts
- **GOTCHA**: Promise.all for concurrent group processing. Slice not splice (immutable).
- **VALIDATE**: Test concurrency cap respected, empty ready groups returns 0

### Task 8: Create scheduler.ts — onMerge callback

- **ACTION**: Re-evaluate ready pool when a PR merges
- **IMPLEMENT**:
  ```typescript
  export async function onMerge(
    prNumber: number,
    plan: PlanData,
    currentMergedPRs: ReadonlySet<number>,
    config: OrchestratorConfig,
    deps: SchedulerDeps,
    now: () => string = () => new Date().toISOString(),
  ): Promise<AssignWorkResult> {
    const updatedMerged = new Set(currentMergedPRs);
    updatedMerged.add(prNumber);
    return assignWork(plan, updatedMerged, config, deps, now);
  }
  ```
- **MIRROR**: IMMUTABILITY_PATTERN — new Set, don't mutate input
- **IMPORTS**: types from types.ts
- **GOTCHA**: Create new Set from input, don't mutate the passed-in set
- **VALIDATE**: Test that merge of dependency unlocks blocked groups

### Task 9: Add AssignWorkResult type to types.ts

- **ACTION**: Add result type for assignWork return value
- **IMPLEMENT**:
  ```typescript
  export interface GroupResult {
    readonly pr_number: number;
    readonly branch: string;
    readonly completed: boolean;
    readonly failedIssue?: number;
    readonly error?: string;
  }

  export interface AssignWorkResult {
    readonly assigned: number;
    readonly results: readonly GroupResult[];
  }
  ```
- **MIRROR**: NAMING_CONVENTION — readonly fields, PascalCase
- **IMPORTS**: None
- **GOTCHA**: Keep in types.ts with other shared types
- **VALIDATE**: `pnpm run typecheck` passes

### Task 10: Write scheduler.test.ts — getReadyGroups tests

- **ACTION**: Test getReadyGroups with various dependency scenarios
- **IMPLEMENT**: Tests covering:
  - Group with no deps → always ready
  - Group with all deps merged → ready
  - Group with unmerged deps → not ready
  - Mixed: some ready, some blocked
  - Already done/merged groups excluded
  - Empty plan → empty result
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: types, scheduler functions
- **GOTCHA**: Use ReadonlySet for mergedPRs in tests
- **VALIDATE**: `pnpm run test -- --run src/scheduler.test.ts`

### Task 11: Write scheduler.test.ts — processGroup tests (via assignWork)

- **ACTION**: Test full lifecycle through assignWork with mock deps
- **IMPLEMENT**: Create mock SchedulerDeps factory:
  ```typescript
  function createMockDeps(overrides?: Partial<SchedulerDeps>): SchedulerDeps {
    const statuses = new Map<string, GroupStatus>();
    return {
      createWorktree: vi.fn(() => ({ branch: 'test', worktreePath: '/tmp/wt' })),
      removeWorktree: vi.fn(),
      spawnWorker: vi.fn((_issue, _slug, _path, onEvent) => {
        process.nextTick(() => onEvent('exited', 0));
        return { id: 'test-1', issue: '1', groupSlug: 'test', pid: 123 };
      }),
      killWorker: vi.fn(async () => {}),
      verify: vi.fn(async () => ({ success: true, steps: [] })),
      readGroupStatus: vi.fn((slug) => statuses.get(slug) ?? null),
      writeGroupStatus: vi.fn((slug, data) => { statuses.set(slug, data); }),
      readContext: vi.fn(() => null),
      deleteContext: vi.fn(),
      ...overrides,
    };
  }
  ```
  Tests covering:
  - Single group, single issue → success path (worktree created, worker spawned, verified, status updated)
  - Single group, multiple issues → serial execution in order
  - Worker fails → returns error, does not advance
  - Verification fails → returns error with failedStep
  - On complete → status set to 'reviewing'
  - Status transitions: idle → cloning → coding → verifying → idle (per issue) → reviewing (group done)
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: types, scheduler functions
- **GOTCHA**: spawnWorker mock must call onEvent('exited', N) async (process.nextTick) to match real behavior
- **VALIDATE**: `pnpm run test -- --run src/scheduler.test.ts`

### Task 12: Write scheduler.test.ts — assignWork concurrency + onMerge tests

- **ACTION**: Test concurrency cap and merge callback
- **IMPLEMENT**: Tests covering:
  - 5 ready groups, max_concurrent=2 → only 2 assigned
  - Fewer ready groups than cap → runs what's available
  - All groups blocked → assigned=0
  - onMerge adds PR to merged set and re-evaluates
  - onMerge unlocks previously blocked group
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: types, scheduler functions
- **GOTCHA**: Use deterministic `now()` for timestamp assertions
- **VALIDATE**: `pnpm run test -- --run src/scheduler.test.ts`

### Task 13: Write scheduler.test.ts — edge cases

- **ACTION**: Test edge cases from acceptance criteria
- **IMPLEMENT**: Tests covering:
  - Empty plan (no groups) → assigned=0
  - Group with 0 issues → completes immediately
  - Context file exists from previous attempt → passed to worker
  - Context file deleted on success
  - Status files written at each transition (verify call count and args)
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: types, scheduler functions
- **GOTCHA**: Use `vi.fn()` call tracking to verify exact sequence of status writes
- **VALIDATE**: `pnpm run test -- --run src/scheduler.test.ts`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| getReadyGroups — no deps | Group with empty depends_on | Returns group | No |
| getReadyGroups — deps merged | Group with deps all in mergedPRs | Returns group | No |
| getReadyGroups — deps unmerged | Group with deps not in mergedPRs | Empty array | No |
| getReadyGroups — mixed | Multiple groups with varying deps | Only ready ones | No |
| getReadyGroups — done/merged excluded | Groups with status 'done'/'merged' | Excluded | Yes |
| getReadyGroups — empty plan | Plan with no groups | Empty array | Yes |
| assignWork — success single group | 1 ready group, 1 issue, all pass | assigned=1, completed=true | No |
| assignWork — serial issues | 1 group, 3 issues | All processed in order | No |
| assignWork — worker fails | Worker exits non-zero | completed=false, failedIssue set | No |
| assignWork — verify fails | Verify returns success=false | completed=false, error set | No |
| assignWork — concurrency cap | 5 ready, cap=2 | assigned=2 | No |
| assignWork — fewer than cap | 1 ready, cap=3 | assigned=1 | Yes |
| assignWork — all blocked | No groups ready | assigned=0 | Yes |
| assignWork — status transitions | Track writeGroupStatus calls | Correct sequence of steps | No |
| onMerge — unlocks group | Merge dep, re-evaluate | Newly unblocked group processed | No |
| context — read + pass to worker | Context exists | Passed as contextContent | Yes |
| context — deleted on success | Issue passes | deleteContext called | No |
| group complete — reviewing | All issues done | step='reviewing' | No |

### Edge Cases Checklist

- [x] Empty plan (no groups)
- [x] Group with 0 issues
- [x] All groups blocked
- [x] Fewer ready groups than cap
- [x] Worker error (non-zero exit)
- [x] Verification failure
- [x] Context from previous attempt
- [x] Status file transitions verified

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
pnpm run test -- --run src/scheduler.test.ts
```
EXPECT: All tests pass

### Full Test Suite
```bash
pnpm run test -- --run
```
EXPECT: No regressions

### Build
```bash
pnpm run build
```
EXPECT: Clean build

---

## Acceptance Criteria

- [x] `getReadyGroups(plan, mergedPRs)` returns PR groups with all cross-group dependencies satisfied
- [x] Respects `max_concurrent_agents` cap — never assigns more workers than configured
- [x] Within a group, issues execute in topological order based on `## Blocked by` dependencies
- [x] `assignWork()` coordinates: worktree creation → worker spawn → status update
- [x] On worker completion: triggers verification pipeline
- [x] On verify pass: deletes context file, advances to next issue in group
- [x] On verify fail: delegates to retry logic (returns error for caller to handle)
- [x] On all issues complete: signals PR group ready for self-review (step='reviewing')
- [x] `onMerge(prNumber)` re-evaluates ready pool and assigns new work
- [x] Handles edge case: all groups blocked (nothing to schedule, returns assigned=0)
- [x] Handles edge case: fewer ready groups than max_concurrent (runs what's available)
- [x] Status files updated at each state transition (issue start, verify start, complete, etc.)
- [x] Tests mock all dependencies (via SchedulerDeps) and verify scheduling logic

## Completion Checklist

- [ ] Code follows discovered patterns (module-level functions, readonly types, immutable updates)
- [ ] Error handling matches codebase style (descriptive Error messages)
- [ ] Tests follow test patterns (vi.mock, tmpDir cleanup, beforeEach/afterEach)
- [ ] No hardcoded values (timeouts from config, paths from helpers)
- [ ] No unnecessary scope additions (no TUI, no retry logic, no review logic)
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Slug derivation diverges from worktree-manager | Low | High — status/worktree path mismatch | Extract shared slug function or import from worktree-manager |
| Worker event callback timing | Medium | Medium — test flakiness | Use process.nextTick in mock, match real spawnWorker behavior |
| Promise.all concurrent group failure handling | Low | Medium — one group failure doesn't stop others | Promise.all rejects on first failure; consider Promise.allSettled if partial results needed |

## Notes

- The `processIssue` and `processGroup` functions are internal (not exported). Only `getReadyGroups`, `assignWork`, and `onMerge` are the public API.
- Retry logic (#15) will wrap `processIssue` failure handling — current design returns error for caller to decide.
- Self-review (#16) will hook into the `step: 'reviewing'` state.
- The `now()` parameter pattern enables deterministic testing — matches `status-manager.ts:135`.
- Consider exporting `deriveGroupSlug` if other modules need it (or extract to shared util). For now, keep private.
- Promise.all is used for concurrent group processing — if partial results are needed on failure, switch to Promise.allSettled in a future iteration.
