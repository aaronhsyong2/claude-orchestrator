# Plan: Self-Review Cycle with Severity-Gated Fix Loop

## Summary
After all issues in a PR group complete, spawn a standalone `claude -p` session (outside the worker pool) to review all commits on the branch against the base branch. Findings are classified by severity (critical/high/medium/low). Critical or high findings trigger a worker fix → verification → re-review loop, up to `max_review_cycles` (default 3). Medium/low findings are noted but don't block. If critical/high persist after max cycles, escalate to NEEDS_INPUT.

## User Story
As the orchestrator system,
I want automated self-review of completed PR groups before PR creation,
So that code quality issues are caught and fixed without human intervention.

## Problem → Solution
Groups go straight from implementation to PR creation with no review step → Groups pass through a severity-gated review loop that catches and fixes critical/high issues automatically.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (GitHub issue #16)
- **PRD Phase**: N/A
- **Estimated Files**: 5 (1 new, 4 updated)

---

## UX Design

N/A — internal change. No user-facing UX transformation. The TUI dashboard already shows `step: 'reviewing'` from the scheduler signal.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts` | 1-179 | All type definitions — extend GroupStep, add review types |
| P0 | `src/retry-coordinator.ts` | 1-258 | Loop + escalation pattern to mirror for review cycles |
| P0 | `src/scheduler.ts` | 151-198 | `processGroup` — integration point after all issues complete |
| P0 | `src/worker-manager.ts` | 73-174 | `spawnWorker` — how to spawn claude -p sessions |
| P1 | `src/config.ts` | 1-100 | Config shape, `rule_files`, `max_review_cycles` already exist |
| P1 | `src/verification.ts` | 1-137 | Verification pipeline called after fixes |
| P2 | `src/retry-coordinator.test.ts` | 1-80 | Test patterns: makeConfig, makeStatus, makeSpawnWorker helpers |
| P2 | `src/scheduler.test.ts` | 1-68 | Test patterns: createMockDeps, makeGroup, makePlan helpers |

## External Documentation

No external research needed — feature uses established internal patterns (spawn, retry loop, context accumulation).

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/retry-coordinator.ts:36-50
export interface RetryDeps {
  readonly spawnWorker: (...) => WorkerHandle;
  readonly verify: (...) => Promise<VerifyResult>;
  // ... all fields readonly
}

export interface RetryResult {
  readonly success: boolean;
  readonly attempts: number;
  readonly escalated: boolean;
  readonly escalationReason?: string;
}
```
Convention: interfaces with `readonly` fields, `Deps` suffix for dependency injection, `Result` suffix for return types.

### ERROR_HANDLING
```typescript
// SOURCE: src/retry-coordinator.ts:232-257
function escalate(
  issue: number,
  groupSlug: string,
  currentStatus: GroupStatus,
  reason: string,
  config: OrchestratorConfig,
  deps: RetryDeps,
  attempts: number,
): RetryResult {
  deps.writeGroupStatus(groupSlug, {
    ...currentStatus,
    step: 'idle',
    step_result: 'needs-input',
    last_updated: now(),
  });
  void deps.notify(`${groupSlug} #${issue}: ${reason}`, config.notifications);
  return { success: false, attempts, escalated: true, escalationReason: reason };
}
```

### CONTEXT_ACCUMULATION
```typescript
// SOURCE: src/retry-coordinator.ts:191-202
function appendContext(deps, groupSlug, issue, attempt, error): void {
  const existing = deps.readContext(groupSlug, String(issue)) ?? '';
  const entry = buildContextEntry(attempt, error);
  const updated = existing ? `${existing}\n${entry}` : entry;
  deps.writeContext(groupSlug, String(issue), updated);
}
```

### SPAWN_PATTERN
```typescript
// SOURCE: src/worker-manager.ts:99-103
const proc = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
  cwd: worktreePath,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ECC_HOOK_PROFILE: 'minimal', ECC_GATEGUARD: 'off' },
});
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/retry-coordinator.test.ts:42-68
function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return { ...defaults, ...overrides };
}
function makeStatus(overrides?: Partial<GroupStatus>): GroupStatus {
  return { ...defaults, ...overrides };
}
// Mock spawn: function makeSpawnWorker(exitCodes: number[]): SpawnFn
```

### STATUS_UPDATE
```typescript
// SOURCE: src/scheduler.ts:34-51
function safeWriteStatus(deps, slug, data): void {
  try { deps.writeGroupStatus(slug, data); }
  catch (err) { process.stderr.write(...); }
}
function freshStatus(slug, group, deps, now): GroupStatus {
  return deps.readGroupStatus(slug) ?? initGroupStatus(group, slug, now);
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/self-reviewer.ts` | CREATE | New module: review prompt building, finding parsing, review-fix loop |
| `src/self-reviewer.test.ts` | CREATE | Tests for review prompt, parsing, cycle logic |
| `src/types.ts` | UPDATE | Add `FindingSeverity`, `Finding`, `ReviewResult`, `SelfReviewDeps` types |
| `src/scheduler.ts` | UPDATE | Call `selfReview()` after all issues complete, before returning |
| `src/scheduler.test.ts` | UPDATE | Add tests for self-review integration in processGroup |

## NOT Building

- PR creation (issue #17)
- PR review by external reviewer (issue #17)
- Merge detection (issue #17)
- Rule file glob resolution (assume paths are pre-resolved and passed as content)
- Git diff generation (use `git diff` command directly in prompt building)

---

## Step-by-Step Tasks

### Task 1: Add review types to types.ts
- **ACTION**: Add severity, finding, review result, and self-review deps types
- **IMPLEMENT**:
  ```typescript
  export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

  export interface Finding {
    readonly severity: FindingSeverity;
    readonly file: string;
    readonly description: string;
  }

  export interface ReviewResult {
    readonly findings: readonly Finding[];
    readonly approved: boolean;
    readonly cycle: number;
  }

  export interface SelfReviewDeps {
    readonly spawnWorker: (
      issue: string,
      groupSlug: string,
      worktreePath: string,
      onEvent: (event: WorkerEvent) => void,
      contextContent?: string,
    ) => WorkerHandle;
    readonly verify: (cwd: string, commands: readonly VerifyCommand[]) => Promise<VerifyResult>;
    readonly readContext: (groupSlug: string, issue: string) => string | null;
    readonly writeContext: (groupSlug: string, issue: string, content: string) => void;
    readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
    readonly notify: (message: string, config: NotificationConfig) => Promise<void>;
    readonly now?: () => string;
  }
  ```
- **MIRROR**: RetryDeps pattern — all readonly fields, deps injection
- **IMPORTS**: WorkerEvent, WorkerHandle, VerifyCommand, VerifyResult, GroupStatus, NotificationConfig (all local)
- **GOTCHA**: Keep all fields `readonly` per codebase immutability convention
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create self-reviewer.ts — review prompt builder
- **ACTION**: Create `buildReviewPrompt()` that constructs the reviewer's prompt
- **IMPLEMENT**:
  ```typescript
  export function buildReviewPrompt(
    baseBranch: string,
    branch: string,
    ruleFileContents: readonly string[],
  ): string
  ```
  Prompt includes:
  1. Instruction to review diff between `baseBranch` and `branch`
  2. Rule file contents injected verbatim
  3. Instruction to output findings as JSON array: `[{"severity":"...", "file":"...", "description":"..."}]`
  4. Classification rubric: critical = security/data-loss, high = correctness/breaking, medium = style/perf, low = nits
- **MIRROR**: buildPrompt pattern from worker-manager.ts
- **IMPORTS**: None needed
- **GOTCHA**: Prompt must instruct claude to output ONLY the JSON array so parsing is reliable. Wrap in fenced block instruction.
- **VALIDATE**: Unit test with expected prompt structure

### Task 3: Create self-reviewer.ts — finding parser
- **ACTION**: Create `parseFindings()` that extracts findings from reviewer output
- **IMPLEMENT**:
  ```typescript
  export function parseFindings(output: string): readonly Finding[]
  ```
  1. Extract JSON array from output (look for `[` ... `]` block)
  2. Parse JSON, validate each entry has severity/file/description
  3. Filter to valid severities only
  4. Return empty array if parsing fails (graceful degradation)
- **MIRROR**: parseNdjsonLine defensive parsing from worker-manager.ts
- **IMPORTS**: Finding, FindingSeverity from types.ts
- **GOTCHA**: Reviewer output may have prose around the JSON — extract the array robustly
- **VALIDATE**: Unit tests with clean JSON, wrapped JSON, malformed output

### Task 4: Create self-reviewer.ts — hasBlockingFindings helper
- **ACTION**: Create helper to check if findings contain critical or high severity
- **IMPLEMENT**:
  ```typescript
  export function hasBlockingFindings(findings: readonly Finding[]): boolean {
    return findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  }
  ```
- **MIRROR**: Simple predicate, no deps
- **IMPORTS**: Finding from types.ts
- **VALIDATE**: Unit test with various severity combos

### Task 5: Create self-reviewer.ts — buildFixPrompt
- **ACTION**: Create prompt builder for the fix worker
- **IMPLEMENT**:
  ```typescript
  export function buildFixPrompt(findings: readonly Finding[]): string
  ```
  Includes only critical/high findings. Format: numbered list with file + description. Instructs worker to fix each finding and commit.
- **MIRROR**: buildPrompt from worker-manager.ts
- **IMPORTS**: Finding from types.ts
- **VALIDATE**: Unit test with mixed severity findings — only critical/high in output

### Task 6: Create self-reviewer.ts — selfReview main loop
- **ACTION**: Create the review-fix cycle loop
- **IMPLEMENT**:
  ```typescript
  export async function selfReview(
    groupSlug: string,
    worktreePath: string,
    currentStatus: GroupStatus,
    config: OrchestratorConfig,
    deps: SelfReviewDeps,
  ): Promise<ReviewResult>
  ```
  Loop logic:
  1. For cycle 1..max_review_cycles:
     a. Update status: step='reviewing', step_result=`review cycle ${cycle}`
     b. Spawn reviewer (standalone claude -p with review prompt + rule files)
     c. Wait for exit, capture result message
     d. Parse findings from result
     e. If no blocking findings → return `{ findings, approved: true, cycle }`
     f. If blocking findings and cycle < max:
        - Spawn fix worker (from pool — uses spawnWorker dep)
        - Wait for fix worker exit
        - Run verification pipeline
        - If verification fails, append to review context and continue
        - Append review feedback as context for next cycle
     g. If blocking findings and cycle = max → return `{ findings, approved: false, cycle }`
  2. Escalation handled by caller (scheduler)

  **Key detail**: The reviewer spawns via spawnWorker but with a REVIEW prompt instead of `/pick-up`. Use a review-specific issue key like `review-${groupSlug}` so it gets its own log file but doesn't conflict with issue context.
- **MIRROR**: executeWithRetry loop structure from retry-coordinator.ts
- **IMPORTS**: SelfReviewDeps, ReviewResult, Finding, GroupStatus, OrchestratorConfig from types.ts; buildReviewPrompt, parseFindings, hasBlockingFindings, buildFixPrompt from self
- **GOTCHA**: Reviewer must NOT consume a worker pool slot. Since we use the deps.spawnWorker injection, the reviewer is just another claude -p process — pool management is the caller's concern. The reviewer uses a dedicated context key (`review-${groupSlug}`) separate from issue context.
- **GOTCHA**: Must capture the `result` message from NDJSON stream to get reviewer output. Listen for `NdjsonResultMessage` type.
- **VALIDATE**: Unit tests mock spawnWorker to emit result messages with various severity combos

### Task 7: Integrate selfReview into scheduler.ts
- **ACTION**: After all issues complete in `processGroup`, call `selfReview()` before returning
- **IMPLEMENT**:
  In `processGroup`, after the "All issues complete" comment (line 188):
  ```typescript
  // Self-review cycle
  safeWriteStatus(deps, slug, {
    ...finalStatus,
    step: 'reviewing',
    step_result: 'self-review starting',
    last_updated: now(),
  });

  const reviewResult = await selfReview(
    slug,
    worktreeInfo.worktreePath, // Need worktree for review
    freshStatus(slug, group, deps, now),
    config,
    {
      spawnWorker: deps.spawnWorker,
      verify: deps.verify,
      readContext: deps.readContext,
      writeContext: deps.writeContext,
      writeGroupStatus: deps.writeGroupStatus,
      notify: deps.notify,
    },
  );

  if (!reviewResult.approved) {
    safeWriteStatus(deps, slug, {
      ...freshStatus(slug, group, deps, now),
      step: 'idle',
      step_result: 'needs-input',
      last_updated: now(),
    });
    void deps.notify(
      `${slug}: self-review found unresolved critical/high findings after ${reviewResult.cycle} cycles`,
      config.notifications,
    );
    return { completed: false, error: 'self-review: unresolved critical/high findings' };
  }

  // Review passed — signal done
  safeWriteStatus(deps, slug, {
    ...freshStatus(slug, group, deps, now),
    step: 'reviewing',
    step_result: 'self-review passed',
    last_updated: now(),
  });

  return { completed: true };
  ```
  **IMPORTANT**: The worktree lifecycle needs adjustment. Currently, each issue creates/destroys its own worktree. For self-review, the group's branch worktree needs to exist. Two approaches:
  - Option A: Create a fresh worktree for the review phase in processGroup
  - Option B: Keep the last issue's worktree alive until after review

  **Choose Option A** — cleaner separation. Create worktree at start of review, destroy in finally block.
- **MIRROR**: processIssue try/finally worktree pattern
- **IMPORTS**: selfReview from self-reviewer.ts
- **GOTCHA**: Worktree creation for review uses the group branch (not creating a new one). The branch already has all committed work from issues.
- **VALIDATE**: Scheduler tests verify review integration

### Task 8: Write self-reviewer.test.ts — comprehensive tests
- **ACTION**: Create test file with full coverage of review logic
- **IMPLEMENT**: Test cases:
  1. `buildReviewPrompt` — includes diff instruction, rule files, JSON output format
  2. `parseFindings` — valid JSON array, wrapped in prose, malformed input, empty
  3. `hasBlockingFindings` — critical only, high only, medium/low only, empty
  4. `buildFixPrompt` — filters to critical/high only, formats as numbered list
  5. `selfReview` — clean review (no findings) exits cycle 1
  6. `selfReview` — medium/low only → approved: true
  7. `selfReview` — critical findings → fix → clean re-review → approved: true, cycle 2
  8. `selfReview` — critical persists through max cycles → approved: false
  9. `selfReview` — verification fails after fix → continues to next cycle
  10. `selfReview` — reviewer crash (exit code != 0) → treats as needs-input
  11. `selfReview` — status updates at each phase of the loop
- **MIRROR**: makeConfig, makeStatus, makeSpawnWorker patterns from retry-coordinator.test.ts
- **IMPORTS**: All exports from self-reviewer.ts, types
- **GOTCHA**: Mock spawnWorker needs to emit both `message` events (for result capture) and `exited` events. Use process.nextTick for async simulation.
- **VALIDATE**: `pnpm run test -- --run src/self-reviewer.test.ts`

### Task 9: Update scheduler.test.ts — review integration tests
- **ACTION**: Add tests for self-review flow in processGroup via assignWork
- **IMPLEMENT**: Test cases:
  1. Group completes all issues → selfReview called → approved → completed: true
  2. Group completes all issues → selfReview fails → completed: false with error
  3. Status transitions through 'reviewing' step during self-review
- **MIRROR**: Existing assignWork tests in scheduler.test.ts
- **IMPORTS**: Additional mocks for selfReview behavior
- **GOTCHA**: selfReview is called inside processGroup which is not directly exported. Test via assignWork. May need to mock the selfReview module import.
- **VALIDATE**: `pnpm run test -- --run src/scheduler.test.ts`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| buildReviewPrompt basic | branch, base, rules | Prompt with diff instruction + rules + JSON format | No |
| buildReviewPrompt no rules | branch, base, [] | Prompt without rule section | Yes |
| parseFindings valid JSON | `[{"severity":"critical",...}]` | Finding[] with 1 entry | No |
| parseFindings prose-wrapped | `Here are findings:\n[...]` | Extracted Finding[] | Yes |
| parseFindings malformed | `not json at all` | Empty array | Yes |
| parseFindings invalid severity | `[{"severity":"urgent",...}]` | Filtered out | Yes |
| hasBlockingFindings critical | [critical finding] | true | No |
| hasBlockingFindings medium only | [medium finding] | false | No |
| hasBlockingFindings empty | [] | false | Yes |
| buildFixPrompt mixed | [critical, medium, low] | Only critical in output | No |
| selfReview clean | No findings | approved: true, cycle: 1 | No |
| selfReview medium only | Medium findings | approved: true, cycle: 1 | No |
| selfReview fix loop success | Critical → fix → clean | approved: true, cycle: 2 | No |
| selfReview max cycles | Critical persists | approved: false, cycle: 3 | No |
| selfReview verify fails | Fix → verify fail → retry | Continues to next cycle | Yes |
| selfReview reviewer crash | Exit code 1 | approved: false, cycle: 1 | Yes |

### Edge Cases Checklist
- [x] Empty findings (no issues found)
- [x] Malformed reviewer output (unparseable)
- [x] Reviewer process crash (non-zero exit)
- [x] Max cycles exhausted with blocking findings
- [x] Verification failure after fix
- [x] Only medium/low findings (should pass)
- [x] Mixed severities (only critical/high block)

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
pnpm run test -- --run src/self-reviewer.test.ts
```
EXPECT: All tests pass

### Integration Tests
```bash
pnpm run test -- --run src/scheduler.test.ts
```
EXPECT: All tests pass, including new review integration tests

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
- [x] `selfReview()` spawns standalone `claude -p` with review prompt + injected rule files
- [x] Reviewer prompt includes: diff against base branch, rule file contents, severity classification instruction
- [x] Findings parsed from reviewer output and classified: critical, high, medium, low
- [x] Critical or high findings → worker from pool assigned to fix
- [x] Worker fix prompt includes specific findings to address
- [x] After fix committed, verification pipeline runs before re-review
- [x] Review-fix loop runs up to `max_review_cycles` (default 3)
- [x] Loop exits early if no critical/high findings remain
- [x] Medium/low findings noted but don't block PR creation
- [x] After max cycles with critical/high remaining → NEEDS_INPUT + notification
- [x] Self-reviewer does NOT consume a worker pool slot
- [x] Tests mock reviewer output with various severity combinations and verify cycle logic

## Completion Checklist
- [ ] Code follows discovered patterns (RetryDeps, escalate, freshStatus)
- [ ] Error handling matches codebase style (safeWriteStatus, try/catch)
- [ ] Status updates use freshStatus → safeWriteStatus pattern
- [ ] Tests follow test patterns (makeConfig, makeStatus, createMockDeps)
- [ ] No hardcoded values (uses config.max_review_cycles)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reviewer output not parseable as JSON | Medium | Medium | Graceful fallback: unparseable = no findings = approved. Log warning. |
| Review prompt too large (many rule files) | Low | Low | Rule files are typically small markdown files; prompt length is bounded |
| Worktree creation fails for review phase | Low | High | Same try/catch pattern as processIssue; escalate on failure |

## Notes
- The `max_review_cycles` config field already exists in `OrchestratorConfig` (default 3) — no config changes needed.
- The `rule_files` config field already exists — the caller (scheduler) resolves globs and reads contents before passing to `buildReviewPrompt`.
- The reviewer uses the same `spawnWorker` function but with a review-specific prompt instead of `/pick-up`. The "issue" parameter for logging purposes uses `review-${groupSlug}`.
- Result capture: the reviewer's output comes via the NDJSON `result` message type. The `selfReview` function listens for this event to extract the review text.
