# Plan: PR Review + Comment Fixing + Merge Detection (#17)

## Summary
After self-review passes, push branch, create PR via `gh pr create`, spawn standalone PR reviewer, run severity-gated review/fix loop, and implement a merge detection state machine that polls GitHub (with git fallback) to trigger scheduler callbacks and worktree cleanup.

## User Story
As the orchestrator system,
I want to automatically create PRs, review them externally, fix comments, and detect merges,
So that the full PR lifecycle is autonomous after self-review passes.

## Problem → Solution
Self-review passes → group marked complete, no PR created → must manually handle PRs.
→ Self-review passes → push + PR creation → external review loop → merge detection → scheduler unlock.

## Metadata
- **Complexity**: Large
- **Source PRD**: GitHub Issue #17
- **PRD Phase**: N/A (standalone)
- **Estimated Files**: 8 new + 3 updated

---

## UX Design

N/A — internal change. Progress messages emitted to TUI via existing `writeGroupStatus` pattern.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts` | all | All type definitions to extend |
| P0 | `src/scheduler.ts` | 188-263 | processGroup — where PR creation hooks in after self-review |
| P0 | `src/self-reviewer.ts` | 215-303 | selfReview loop — pattern for PR review loop |
| P0 | `src/scheduler.ts` | 318-329 | onMerge — callback to re-evaluate ready pool |
| P1 | `src/retry-coordinator.ts` | 206-230 | withBackoff — reuse for merge polling |
| P1 | `src/worker-manager.ts` | 73-174 | spawnWorker — spawning claude process |
| P1 | `src/orchestrate.ts` | all | Entry point, buildRealDeps, wrapWithProgress |
| P2 | `src/self-reviewer.test.ts` | 1-107 | Test helpers: makeConfig, makeStatus, makeSequentialSpawn |
| P2 | `src/worktree-manager.ts` | all | create/remove worktree interface |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `gh pr create` | GitHub CLI docs | `gh pr create --title T --body B --base main --head branch` returns PR URL + number |
| `gh pr view` | GitHub CLI docs | `gh pr view N --json state` returns `{"state":"MERGED"|"OPEN"|"CLOSED"}` |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/self-reviewer.ts:1-12, src/retry-coordinator.ts:1-9
// Files: kebab-case (pr-reviewer.ts, merge-detector.ts)
// Functions: camelCase (prReview, startMergeDetector)
// Types: PascalCase (PRReviewDeps, MergeDetectorState)
// Constants: UPPER_SNAKE (MAX_CONSECUTIVE_CRASHES, KILL_TIMEOUT_MS)
```

### ERROR_HANDLING
```typescript
// SOURCE: src/scheduler.ts:34-42
/** Wrap writeGroupStatus to prevent I/O errors from crashing the entire orchestration. */
function safeWriteStatus(deps: SchedulerDeps, slug: string, data: GroupStatus): void {
    try {
        deps.writeGroupStatus(slug, data);
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[scheduler] status write failed for ${slug}: ${detail}\n`);
    }
}
```

### LOGGING_PATTERN
```typescript
// SOURCE: src/worker-manager.ts:135-137, src/worktree-manager.ts
// Format: [module-name] message for slug/issue: detail
process.stderr.write(`[worker-manager] unparseable NDJSON for ${groupSlug}/${issue}: ${line.slice(0, 120)}\n`);
```

### DEPS_INJECTION_PATTERN
```typescript
// SOURCE: src/self-reviewer.ts:215-221, src/retry-coordinator.ts:66-77
// Every module takes a Deps interface with injectable functions for testing.
// Optional `now?: () => string` for time injection.
export async function selfReview(
    groupSlug: string,
    worktreePath: string,
    currentStatus: GroupStatus,
    config: OrchestratorConfig,
    deps: SelfReviewDeps,
): Promise<ReviewResult> {
```

### SPAWN_AND_CAPTURE_PATTERN
```typescript
// SOURCE: src/self-reviewer.ts:312-344
function spawnAndCapture(
    issue: string,
    groupSlug: string,
    worktreePath: string,
    prompt: string,
    deps: SelfReviewDeps,
): Promise<SpawnCaptureResult> {
    return new Promise<SpawnCaptureResult>((resolve, reject) => {
        let resultText: string | null = null;
        try {
            deps.spawnWorker(issue, groupSlug, worktreePath, (event: WorkerEvent) => {
                if (event.event === 'message' && event.data.type === 'result') {
                    resultText = (event.data as NdjsonResultMessage).result;
                }
                if (event.event === 'exited') resolve({ exitCode: event.data, resultText });
                if (event.event === 'error') resolve({ exitCode: 1, resultText: null });
            }, prompt);
        } catch (err) { reject(err); }
    });
}
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/self-reviewer.test.ts:17-107
const NOW = '2026-05-03T12:00:00.000Z';

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig { ... }
function makeStatus(overrides?: Partial<GroupStatus>): GroupStatus { ... }
function makeSequentialSpawn(behaviors: ReadonlyArray<...>): SpawnFn { ... }
function createMockDeps(overrides?: Partial<SelfReviewDeps>): SelfReviewDeps {
    return {
        spawnWorker: vi.fn(makeReviewerSpawn('[]')),
        verify: vi.fn(async () => ({ success: true as const, steps: [] })),
        readContext: vi.fn(() => null),
        writeContext: vi.fn(),
        writeGroupStatus: vi.fn(),
        notify: vi.fn(async () => {}),
        now: () => NOW,
        ...overrides,
    };
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add PRReviewDeps, MergeDetectorDeps, MergeDetectorState, PRReviewResult, GroupStep extension |
| `src/pr-reviewer.ts` | CREATE | PR review loop: spawn standalone reviewer, parse comments, spawn fixer |
| `src/pr-reviewer.test.ts` | CREATE | Tests for PR review cycle |
| `src/pr-creator.ts` | CREATE | Push branch + `gh pr create` logic |
| `src/pr-creator.test.ts` | CREATE | Tests for PR creation |
| `src/merge-detector.ts` | CREATE | Polling state machine: GITHUB_POLLING ↔ GIT_FALLBACK |
| `src/merge-detector.test.ts` | CREATE | Tests for merge detector state machine |
| `src/scheduler.ts` | UPDATE | After self-review passes → PR creation → PR review → merge detector |
| `src/orchestrate.ts` | UPDATE | Wire new deps (execCommand for gh/git) |
| `src/scheduler.test.ts` | UPDATE | Add tests for new post-self-review flow |

## NOT Building

- Auto-merge (user merges manually)
- CI/CD integration
- Multi-repo PR coordination
- GitHub webhook listener (polling only)
- PR template customization beyond title/body

---

## Step-by-Step Tasks

### Task 1: Extend types
- **ACTION**: Add new types to `src/types.ts`
- **IMPLEMENT**:
  ```typescript
  // Extend GroupStep
  export type GroupStep = 'idle' | 'cloning' | 'coding' | 'verifying' | 'reviewing' | 'pr-creating' | 'pr-reviewing' | 'awaiting-merge';

  // PR Review types
  export interface PRComment {
    readonly file: string;
    readonly line: number | null;
    readonly body: string;
    readonly severity: FindingSeverity;
  }

  export interface PRReviewResult {
    readonly comments: readonly PRComment[];
    readonly approved: boolean;
    readonly cycle: number;
  }

  export interface PRReviewDeps {
    readonly spawnWorker: SelfReviewDeps['spawnWorker'];
    readonly verify: SelfReviewDeps['verify'];
    readonly execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;
    readonly readContext: (groupSlug: string, issue: string) => string | null;
    readonly writeContext: (groupSlug: string, issue: string, content: string) => void;
    readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
    readonly notify: (message: string, config: NotificationConfig) => Promise<void>;
    readonly now?: () => string;
  }

  export interface ExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  // Merge Detector types
  export type MergeDetectorState = 'GITHUB_POLLING' | 'GIT_FALLBACK';

  export interface MergeDetectorDeps {
    readonly execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;
    readonly removeWorktree: (branch: string) => void;
    readonly now?: () => string;
  }

  export interface MergeDetectorHandle {
    readonly stop: () => void;
  }
  ```
- **MIRROR**: Types follow readonly, PascalCase interfaces
- **IMPORTS**: N/A (types file)
- **GOTCHA**: `GroupStep` is a union type used in existing code — adding values is non-breaking but update `emitProgress` in orchestrate.ts
- **VALIDATE**: `pnpm typecheck` passes

### Task 2: Implement PR creator
- **ACTION**: Create `src/pr-creator.ts`
- **IMPLEMENT**:
  ```typescript
  export async function pushAndCreatePR(
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
    worktreePath: string,
    deps: PRReviewDeps,
  ): Promise<{ readonly prNumber: number; readonly url: string }>
  ```
  - `git push -u origin {branch}` via deps.execCommand
  - `gh pr create --title T --body B --base {baseBranch} --head {branch}` via deps.execCommand
  - Parse PR number from gh output (format: `https://github.com/org/repo/pull/N`)
  - On failure: throw with stderr detail
- **MIRROR**: DEPS_INJECTION_PATTERN, ERROR_HANDLING
- **IMPORTS**: `import type { ExecResult, PRReviewDeps } from './types.js';`
- **GOTCHA**: `gh pr create` may fail if PR already exists — handle gracefully by checking `gh pr view {branch}` first
- **VALIDATE**: Unit test with mocked execCommand

### Task 3: Implement PR reviewer
- **ACTION**: Create `src/pr-reviewer.ts`
- **IMPLEMENT**:
  ```typescript
  export function buildPRReviewPrompt(
    prNumber: number,
    ruleContents: readonly string[],
    priorComments: string | null,
  ): string

  export function buildPRFixPrompt(comments: readonly PRComment[]): string

  export function parsePRComments(output: string): readonly PRComment[]

  export function hasBlockingComments(comments: readonly PRComment[]): boolean

  export async function prReview(
    prNumber: number,
    groupSlug: string,
    worktreePath: string,
    currentStatus: GroupStatus,
    config: OrchestratorConfig,
    deps: PRReviewDeps,
  ): Promise<PRReviewResult>
  ```
  - Review prompt: includes `gh pr diff {prNumber}`, rule files, and prior unresolved comments
  - Review loop (1..max_review_cycles):
    1. Write status `step: 'pr-reviewing', step_result: 'PR review cycle N'`
    2. Spawn standalone reviewer (spawn via deps.spawnWorker with PR diff prompt)
    3. Parse comments from output
    4. If no blocking (critical/high): return approved
    5. If last cycle: return unapproved
    6. Spawn fixer worker with buildPRFixPrompt
    7. Run verification pipeline
    8. `git add -A && git commit -m "fix: address PR review comments (cycle N)"`
    9. `git push` via deps.execCommand
    10. Append context for next cycle
- **MIRROR**: SPAWN_AND_CAPTURE_PATTERN, selfReview loop structure exactly
- **IMPORTS**: `import type { PRComment, PRReviewResult, PRReviewDeps, GroupStatus, OrchestratorConfig, WorkerEvent, NdjsonResultMessage } from './types.js';`
- **GOTCHA**: Reviewer is standalone (same spawnWorker but with PR-specific prompt, not `/pick-up`). Commit message must be exactly `fix: address PR review comments (cycle N)`.
- **VALIDATE**: Unit tests verifying review loop, parse, severity gating

### Task 4: Implement merge detector
- **ACTION**: Create `src/merge-detector.ts`
- **IMPLEMENT**:
  ```typescript
  const GITHUB_POLL_INTERVAL_MS = 10_000;
  const GIT_FALLBACK_INTERVAL_MS = 5_000;
  const RECOVERY_POLL_INTERVAL_MS = 60_000;
  const MAX_CONSECUTIVE_FAILURES = 3;

  export function startMergeDetector(
    prNumber: number,
    branch: string,
    cwd: string,
    onMerge: () => void,
    deps: MergeDetectorDeps,
  ): MergeDetectorHandle
  ```
  - State machine: `GITHUB_POLLING` ↔ `GIT_FALLBACK`
  - GITHUB_POLLING state:
    - Poll `gh pr view {prNumber} --json state` every 10s
    - Parse state: if `MERGED` → call onMerge, stop
    - On 3 consecutive failures → transition to GIT_FALLBACK
  - GIT_FALLBACK state:
    - Poll `git fetch origin && git branch -r --contains {branch}` every 5s
    - Check if branch merged into base (compare refs)
    - Background recovery: `gh pr view` every 60s
    - On recovery success → transition back to GITHUB_POLLING
  - MergeDetectorHandle.stop(): clear all timers
  - Use `setInterval`/`setTimeout` with stored refs for cleanup
- **MIRROR**: LOGGING_PATTERN (`[merge-detector]` prefix)
- **IMPORTS**: `import type { MergeDetectorDeps, MergeDetectorHandle, MergeDetectorState, ExecResult } from './types.js';`
- **GOTCHA**: Must clean up all timers on stop(). Use `let stopped = false` guard to prevent callbacks after stop. Git fallback checks `git log origin/{baseBranch} --oneline | grep` or compares merge-base.
- **VALIDATE**: Tests with fake timers verifying state transitions and cleanup

### Task 5: Integrate into scheduler
- **ACTION**: Update `src/scheduler.ts` processGroup to continue after self-review
- **IMPLEMENT**: After self-review passes (line 244-251 current code), add:
  ```typescript
  // --- PR Creation ---
  safeWriteStatus(deps, slug, {
    ...freshStatus(slug, group, deps, now),
    step: 'pr-creating',
    step_result: 'pushing branch',
    last_updated: now(),
  });

  const prResult = await pushAndCreatePR(
    group.branch,
    config.base_branch,
    group.title,
    buildPRBody(group),
    reviewWorktree.worktreePath,
    { ...deps, execCommand: deps.execCommand },
  );

  // --- PR Review Loop ---
  safeWriteStatus(deps, slug, {
    ...freshStatus(slug, group, deps, now),
    step: 'pr-reviewing',
    step_result: `PR #${prResult.prNumber} created`,
    last_updated: now(),
  });

  const prReviewResult = await prReview(
    prResult.prNumber,
    slug,
    reviewWorktree.worktreePath,
    freshStatus(slug, group, deps, now),
    config,
    { ...deps, execCommand: deps.execCommand },
  );

  if (!prReviewResult.approved) {
    // Notify, mark needs-input
    safeWriteStatus(deps, slug, {
      ...freshStatus(slug, group, deps, now),
      step: 'idle',
      step_result: 'needs-input',
      last_updated: now(),
    });
    void deps.notify(
      `${slug}: PR #${prResult.prNumber} has unresolved comments after ${prReviewResult.cycle} cycle(s)`,
      config.notifications,
    );
    return { completed: false, error: 'pr-review: unresolved comments' };
  }

  // PR approved — notify and start merge detector
  void deps.notify(
    `${slug}: PR #${prResult.prNumber} ready to merge`,
    config.notifications,
  );

  safeWriteStatus(deps, slug, {
    ...freshStatus(slug, group, deps, now),
    step: 'awaiting-merge',
    step_result: `PR #${prResult.prNumber} approved`,
    last_updated: now(),
  });
  ```
  - Merge detector started separately (see Task 6)
- **MIRROR**: safeWriteStatus, freshStatus, deps injection patterns
- **IMPORTS**: Add `import { pushAndCreatePR } from './pr-creator.js';` and `import { prReview } from './pr-reviewer.js';`
- **GOTCHA**: Worktree must stay alive through PR review (don't remove until merge detected). Move `removeWorktree` from finally block to merge callback.
- **VALIDATE**: `pnpm typecheck && pnpm test`

### Task 6: Add execCommand to SchedulerDeps
- **ACTION**: Update `SchedulerDeps` in types.ts, implement in orchestrate.ts
- **IMPLEMENT**:
  ```typescript
  // In SchedulerDeps:
  readonly execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

  // In orchestrate.ts buildRealDeps():
  execCommand: (cmd, args, cwd) => execCommandReal(cmd, args, cwd),

  // New helper in orchestrate.ts or separate exec-command.ts:
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';
  const execFileAsync = promisify(execFile);

  export async function execCommandReal(
    cmd: string, args: readonly string[], cwd: string
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, [...args], { cwd });
      return { exitCode: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }
  ```
- **MIRROR**: DEPS_INJECTION_PATTERN
- **IMPORTS**: `import { execFile } from 'node:child_process';` and `import { promisify } from 'node:util';`
- **GOTCHA**: execFile error shape has stdout/stderr on the error object. Cast carefully.
- **VALIDATE**: `pnpm typecheck`

### Task 7: Wire merge detector into orchestration
- **ACTION**: Update scheduler to start merge detector after PR approval; handle onMerge callback
- **IMPLEMENT**:
  - After PR approved in processGroup: start merge detector with `onMerge` callback
  - The `onMerge` callback:
    1. Remove worktree
    2. Call `scheduler.onMerge(prNumber, plan, mergedPRs, config, deps)` to unlock dependents
  - processGroup returns `{ completed: true }` after merge detected (await a Promise that resolves on merge)
  - Alternative: processGroup returns after PR approval, merge detector runs independently. The orchestrate entry point manages merge detection lifecycle.
  - **Decision**: processGroup awaits merge (simpler flow, one group = one lifecycle). Use a Promise wrapper around merge detector:
    ```typescript
    await new Promise<void>((resolve) => {
      startMergeDetector(prResult.prNumber, group.branch, reviewWorktree.worktreePath, () => {
        deps.removeWorktree(group.branch);
        resolve();
      }, { execCommand: deps.execCommand, removeWorktree: deps.removeWorktree });
    });
    ```
- **MIRROR**: Existing processGroup async pattern
- **IMPORTS**: `import { startMergeDetector } from './merge-detector.js';`
- **GOTCHA**: processGroup currently has `finally { removeWorktree }`. Must restructure — remove from finally, handle in merge callback. Only the review worktree stays alive; coding worktree already cleaned up.
- **VALIDATE**: Integration test with fake timers and mock merge event

### Task 8: Update emitProgress for new steps
- **ACTION**: Update `emitProgress` in `src/orchestrate.ts`
- **IMPLEMENT**:
  ```typescript
  if (data.step === 'pr-creating') {
    onProgress(`  PR group ${data.pr_group}: creating PR...`);
  }
  if (data.step === 'pr-reviewing') {
    onProgress(`  PR group ${data.pr_group}: PR review — ${data.step_result}`);
  }
  if (data.step === 'awaiting-merge') {
    onProgress(`  PR group ${data.pr_group}: awaiting merge`);
  }
  ```
- **MIRROR**: Existing emitProgress cases in orchestrate.ts:79-100
- **IMPORTS**: None additional
- **GOTCHA**: None
- **VALIDATE**: Visually verify in TUI (manual)

### Task 9: Write PR creator tests
- **ACTION**: Create `src/pr-creator.test.ts`
- **IMPLEMENT**: Test cases:
  - Happy path: push succeeds, gh pr create returns URL with number
  - Push failure: throws with stderr
  - PR already exists: handles gracefully (gh pr view fallback)
  - Parse PR number from different URL formats
- **MIRROR**: TEST_STRUCTURE pattern
- **IMPORTS**: `import { describe, expect, it, vi } from 'vitest';`
- **GOTCHA**: Mock execCommand, not actual gh/git
- **VALIDATE**: `pnpm test src/pr-creator.test.ts`

### Task 10: Write PR reviewer tests
- **ACTION**: Create `src/pr-reviewer.test.ts`
- **IMPLEMENT**: Test cases:
  - Reviewer approves on first cycle (no comments)
  - Reviewer finds blocking comments → fixer runs → re-review passes
  - Max cycles exhausted → returns unapproved
  - Fixer commits with correct message format
  - Verification failure between fix and push
  - Prior comments included in review prompt for subsequent cycles
  - parsePRComments handles various output formats
- **MIRROR**: TEST_STRUCTURE, makeSequentialSpawn pattern
- **IMPORTS**: `import { describe, expect, it, vi } from 'vitest';`
- **GOTCHA**: Sequential spawn needs review → fix → review alternating behavior injection
- **VALIDATE**: `pnpm test src/pr-reviewer.test.ts`

### Task 11: Write merge detector tests
- **ACTION**: Create `src/merge-detector.test.ts`
- **IMPLEMENT**: Test cases:
  - Happy path: gh pr view returns MERGED → onMerge called
  - State transition: 3 failures → GIT_FALLBACK state
  - Recovery: gh poll succeeds during fallback → back to GITHUB_POLLING
  - Stop: all timers cleared, no callbacks fire after stop
  - Git fallback: detects merge via git fetch
- **MIRROR**: TEST_STRUCTURE; use `vi.useFakeTimers()` for timer control
- **IMPORTS**: `import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';`
- **GOTCHA**: `vi.advanceTimersByTime()` to simulate polling intervals. Must call `vi.useRealTimers()` in afterEach.
- **VALIDATE**: `pnpm test src/merge-detector.test.ts`

### Task 12: Update scheduler tests
- **ACTION**: Update `src/scheduler.test.ts` with new flow tests
- **IMPLEMENT**: Add tests for:
  - Full flow: issues → self-review → PR create → PR review → merge → group complete
  - PR review failure: group ends with 'needs-input'
  - Merge detector cleanup on stop
  - execCommand mock in createMockDeps
- **MIRROR**: Existing scheduler.test.ts patterns
- **IMPORTS**: Existing + new type imports
- **GOTCHA**: Must update createMockDeps to include `execCommand: vi.fn()`
- **VALIDATE**: `pnpm test src/scheduler.test.ts`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| pushAndCreatePR success | Mock gh returns URL | { prNumber, url } | No |
| pushAndCreatePR PR exists | gh pr create fails, view succeeds | Returns existing PR | Yes |
| parsePRComments valid JSON | JSON array in prose | PRComment[] | No |
| parsePRComments empty | `[]` | [] | Yes |
| hasBlockingComments | Mix of severities | true if critical/high | No |
| prReview approves cycle 1 | No blocking comments | { approved: true, cycle: 1 } | No |
| prReview fix loop | Blocking → fix → approve | { approved: true, cycle: 2 } | No |
| prReview max cycles | Always blocking | { approved: false } | Yes |
| merge detector GITHUB_POLLING | gh returns MERGED | onMerge called | No |
| merge detector 3 failures | 3x gh fail | State → GIT_FALLBACK | No |
| merge detector recovery | gh succeeds in fallback | State → GITHUB_POLLING | No |
| merge detector stop | stop() called | No timers fire | Yes |

### Edge Cases Checklist
- [ ] PR already exists (re-run after crash)
- [ ] Reviewer output empty/malformed
- [ ] Git push fails (force-push race)
- [ ] gh command not in PATH
- [ ] Merge detected between review cycles
- [ ] stop() called during active poll
- [ ] Network timeout on gh commands

---

## Validation Commands

### Static Analysis
```bash
pnpm run check
```
EXPECT: Zero lint errors

### Type Check
```bash
pnpm typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm test
```
EXPECT: All tests pass

### Targeted Tests
```bash
pnpm test src/pr-creator.test.ts src/pr-reviewer.test.ts src/merge-detector.test.ts
```
EXPECT: All new tests pass

---

## Acceptance Criteria
- [ ] `gh pr create` called after self-review with appropriate title/body
- [ ] PR reviewer spawned standalone with diff + rule files
- [ ] Reviewer verifies previous comments from prior cycles addressed
- [ ] Reviewer checks config `rule_files` compliance
- [ ] Worker creates batch commit per review cycle: `fix: address PR review comments (cycle N)`
- [ ] Full verification before `git push` (no wasted CI)
- [ ] Review loop: up to `max_review_cycles`, severity-gated
- [ ] On approval: notify "PR ready to merge"
- [ ] Merge Detector polls `gh pr view` every 10s
- [ ] After 3 `gh` failures: fallback to `git fetch` every 5s
- [ ] Background `gh` poll every 60s for recovery
- [ ] On merge: Scheduler callback, worktree cleanup
- [ ] Tests mock `gh`, `git`, reviewer output; verify state machine

## Completion Checklist
- [ ] Code follows discovered patterns (deps injection, safeWriteStatus, spawnAndCapture)
- [ ] Error handling uses stderr with `[module-name]` prefix
- [ ] All types readonly and immutable
- [ ] Tests follow makeConfig/makeStatus/createMockDeps pattern
- [ ] No hardcoded values (intervals as named constants)
- [ ] Commit message: `fix: address PR review comments (cycle N)` enforced
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| processGroup blocks on merge (long await) | High | Medium | Acceptable — one group = one lifecycle; max_concurrent_agents limits parallelism |
| gh CLI not installed on host | Low | High | Validate gh exists at startup or graceful error in pushAndCreatePR |
| Timer leaks in merge detector | Medium | High | Stopped flag + clearInterval/clearTimeout in stop(); tested with fake timers |
| Race: PR merged during review cycle | Low | Medium | Check PR state before pushing fix commits; handle gracefully |

## Notes
- The PR review prompt is distinct from self-review: it operates on the PR diff (`gh pr diff N`) rather than `git diff base...branch`, and includes prior review comments.
- Merge detector is started only after PR approval — not after creation. This avoids unnecessary polling during review.
- The worktree lifecycle changes: coding worktree is still cleaned up per-issue, but the review worktree lives until merge is detected (or failure). This is a structural change to the `finally` block in processGroup.
- `execCommand` is the new primitive that replaces direct `spawn` for simple CLI commands (gh, git push). Unlike `spawnWorker` (which handles NDJSON streaming), this is for one-shot commands.
