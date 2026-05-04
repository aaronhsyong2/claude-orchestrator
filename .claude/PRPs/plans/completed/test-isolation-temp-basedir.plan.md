# Plan: Test Isolation — All Tests Use Temp baseDir

## Summary
The `orchestrate()` function calls `hasExistingState()` without a `baseDir`, reading the real working directory's `.orchestrator/status/`. This causes test failures when active status files exist on disk. Fix by making `hasExistingState` injectable via `OrchestrateOverrides` so tests can stub it.

## User Story
As a developer, I want the test suite to pass regardless of local `.orchestrator/` state, so that active orchestrator runs don't cause false test failures.

## Problem → Solution
`hasExistingState()` reads real cwd `.orchestrator/status/` during tests → inject `hasExistingState` via overrides so tests control it.

## Metadata
- **Complexity**: Small
- **Source PRD**: N/A
- **PRD Phase**: N/A (GitHub issue #39, parent #38)
- **Estimated Files**: 2

---

## UX Design

N/A — internal change.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/orchestrate.ts` | 38-43, 108-140 | OrchestrateOverrides interface + orchestrate function |
| P0 | `src/orchestrate.test.ts` | 126-202 | Existing test structure, how overrides are passed |
| P1 | `src/resume.ts` | 12-26 | `hasExistingState` implementation |

---

## Patterns to Mirror

### OVERRIDE_INJECTION
```typescript
// SOURCE: src/orchestrate.ts:38-43, 113-114
export interface OrchestrateOverrides {
  readonly loadConfig?: () => OrchestratorConfig;
  readonly parsePlan?: (filePath: string) => Promise<PlanData>;
  readonly deps?: SchedulerDeps;
  readonly onShutdown?: (mode: ShutdownMode) => void;
}
// Usage:
const config = (overrides?.loadConfig ?? realLoadConfig)();
```

### TEST_OVERRIDE_USAGE
```typescript
// SOURCE: src/orchestrate.test.ts:133-137
const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
  loadConfig: () => TEST_CONFIG,
  parsePlan: async () => plan,
  deps,
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/orchestrate.ts` | UPDATE | Add `hasExistingState` to OrchestrateOverrides, use it at line 127 |
| `src/orchestrate.test.ts` | UPDATE | Pass `hasExistingState: () => false` in all test overrides |

## NOT Building

- No changes to `resume.ts` — `hasExistingState` signature is fine
- No changes to other test files — agent report confirmed they're already isolated
- No temp dir in orchestrate.test.ts — it doesn't need disk at all, just needs to stub the function
- No `readShutdownFile` changes — no `.orchestrator/shutdown` file exists during tests so it returns null

---

## Step-by-Step Tasks

### Task 1: Add hasExistingState to OrchestrateOverrides

- **ACTION**: Add optional `hasExistingState` field to `OrchestrateOverrides` interface
- **IMPLEMENT**:
  ```typescript
  export interface OrchestrateOverrides {
    readonly loadConfig?: () => OrchestratorConfig;
    readonly parsePlan?: (filePath: string) => Promise<PlanData>;
    readonly deps?: SchedulerDeps;
    readonly onShutdown?: (mode: ShutdownMode) => void;
    readonly hasExistingState?: () => boolean;
  }
  ```
- **MIRROR**: OVERRIDE_INJECTION pattern
- **IMPORTS**: None needed — same file
- **GOTCHA**: Keep `readonly` modifier consistent with other fields
- **VALIDATE**: `pnpm run check` passes (type check)

### Task 2: Use injectable hasExistingState in orchestrate()

- **ACTION**: Replace direct `hasExistingState()` call with overrideable version
- **IMPLEMENT**: At line 127, change:
  ```typescript
  // Before:
  if (hasExistingState()) {
  // After:
  const checkExistingState = overrides?.hasExistingState ?? hasExistingState;
  if (checkExistingState()) {
  ```
- **MIRROR**: Same pattern as `overrides?.loadConfig ?? realLoadConfig` at line 113
- **IMPORTS**: None — `hasExistingState` already imported
- **GOTCHA**: Must declare `checkExistingState` before the if-block, not inline, for readability
- **VALIDATE**: Existing behavior unchanged when no override provided

### Task 3: Pass hasExistingState override in all orchestrate tests

- **ACTION**: Add `hasExistingState: () => false` to every test's overrides object
- **IMPLEMENT**: In each `orchestrate(...)` call, add the field:
  ```typescript
  const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
    loadConfig: () => TEST_CONFIG,
    parsePlan: async () => plan,
    deps,
    hasExistingState: () => false,
  });
  ```
- **MIRROR**: TEST_OVERRIDE_USAGE pattern
- **IMPORTS**: None needed
- **GOTCHA**: Must update ALL orchestrate calls in the test file, not just the failing one
- **VALIDATE**: `pnpm run test -- --run` passes with `.orchestrator/status/*.json` on disk

---

## Testing Strategy

### Verification Test

| Test | Input | Expected Output |
|---|---|---|
| Tests pass with active status | Create `.orchestrator/status/fake.json`, run suite | All 523 tests pass |
| Tests pass without active status | No `.orchestrator/status/`, run suite | All 523 tests pass |

### Edge Cases Checklist
- [x] Empty `.orchestrator/status/` dir — already tested by resume.test.ts
- [x] No `.orchestrator/` dir at all — default case, tests already verify

---

## Validation Commands

### Static Analysis
```bash
pnpm run check
```
EXPECT: Zero type errors

### Full Test Suite
```bash
pnpm run test -- --run
```
EXPECT: All tests pass

### Isolation Proof
```bash
mkdir -p .orchestrator/status && echo '{}' > .orchestrator/status/fake.json && pnpm run test -- --run; rm .orchestrator/status/fake.json
```
EXPECT: All tests pass with active status file present

---

## Acceptance Criteria
- [ ] No test reads real `.orchestrator/` state without temp baseDir
- [ ] `pnpm run test -- --run` passes with active `.orchestrator/status/*.json` on disk
- [ ] Existing test count unchanged — no tests removed or skipped
- [ ] Type check passes

## Completion Checklist
- [ ] `hasExistingState` injectable via OrchestrateOverrides
- [ ] All orchestrate test calls pass the override
- [ ] Both validation commands pass
- [ ] No unnecessary scope additions

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missing an orchestrate() call in tests | Low | Test still flaky | grep for all `orchestrate(` calls in test file |

## Notes
- The agent exploration report initially said "all tests already isolated" — but missed that `orchestrate.test.ts` doesn't mock `hasExistingState`. The in-memory status store handles `readGroupStatus`/`writeGroupStatus` but not the resume detection path.
- `readShutdownFile()` at line 123/168 also reads cwd, but doesn't cause failures because no shutdown file exists. Could add to overrides later if needed (out of scope now).
