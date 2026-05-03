---
phase: 7
plan: 5
subsystem: testing
tags:
  - shutdown
  - resume
  - vitest
  - signal-handling
dependency_graph:
  requires:
    - 07-01 (shutdown.ts)
    - 07-02 (resume.ts)
    - 07-03 (scheduler/lock/orchestrate wiring)
    - 07-04 (TUI integration)
  provides:
    - test coverage for shutdown coordinator
    - test coverage for resume module
    - test coverage for scheduler shutdown checkpoint
    - test coverage for lock signal handler callback
  affects:
    - src/shutdown.test.ts
    - src/resume.test.ts
    - src/scheduler.test.ts
    - src/lock.test.ts
tech_stack:
  added: []
  patterns:
    - vitest describe/it/vi.fn patterns
    - tmpDir setup/teardown for filesystem tests
    - mock dependency injection for async operations
key_files:
  created:
    - src/shutdown.test.ts
    - src/resume.test.ts
  modified:
    - src/scheduler.test.ts
    - src/lock.test.ts
decisions:
  - "Used same tmpDir + beforeEach/afterEach pattern as existing lock.test.ts for consistency"
  - "Tested installSignalHandlers via signature acceptance rather than signal emission (safer, avoids test process termination)"
  - "Used vi.fn() mock for killWorker in forceKillAll tests to verify Promise.allSettled behavior"
metrics:
  duration: ~8min
  completed: 2026-05-03
---

# Phase 7 Plan 5: Tests for Shutdown + Resume Summary

Comprehensive vitest test suite for shutdown coordinator, resume module, scheduler shutdown checkpoint, and lock signal handler callback

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Tests for src/shutdown.ts | 0950875 | src/shutdown.test.ts |
| 2 | Tests for resume, scheduler shutdown, lock handlers | c9ec11d | src/resume.test.ts, src/scheduler.test.ts, src/lock.test.ts |

## What Was Built

### shutdown.test.ts (6 describe blocks, 21 test cases)

- **getShutdownPath**: Path construction with/without baseDir
- **writeShutdownFile**: File creation, directory creation, overwrite (graceful->force), mode validation
- **readShutdownFile**: Missing file, valid file, malformed JSON, invalid mode
- **clearShutdownFile**: Removal, no-op on missing
- **createWorkerRegistry**: Register/deregister/getActivePids lifecycle
- **forceKillAll**: Calls killWorker per PID, empty registry, rejection handling via Promise.allSettled

### resume.test.ts (3 describe blocks, 19 test cases)

- **hasExistingState**: Missing dir, empty dir, JSON files present, non-JSON only
- **resetToCheckpoint**: All 10 branches of the decision tree tested:
  - idle+pass+no-remaining -> restart from self-review
  - reviewing/pr-creating/pr-reviewing -> reset to idle
  - awaiting-merge+merged -> fully done
  - awaiting-merge+not-merged -> unchanged
  - coding/cloning/verifying -> idle (current_issue preserved)
  - idle+interrupted -> clear step_result
  - default -> unchanged
- **detectMergedPRs**: Merged branches, no awaiting-merge, gh failure, skip non-awaiting

### scheduler.test.ts extensions (4 test cases)

- shouldShutdown returns graceful -> loop stops before next issue
- Status written with step_result: 'interrupted' on shutdown
- Current issue completes before shutdown check (no mid-step interruption)
- shouldShutdown undefined -> loop runs normally (backward compat)

### lock.test.ts extensions (2 test cases)

- installSignalHandlers accepts onShutdown callback without error
- Function signature accepts optional parameters

## Acceptance Criteria Verification

- shutdown.test.ts: 6 describe blocks (requires >= 6), 21 it blocks (requires >= 14)
- resume.test.ts: 3 describe blocks (requires >= 3), 19 it blocks (requires >= 10)
- resume.test.ts: 13 resetToCheckpoint references (requires >= 8)
- scheduler.test.ts: 9 shouldShutdown references (requires >= 2)
- scheduler.test.ts: 4 interrupted references (requires >= 1)

## Deviations from Plan

None - plan executed exactly as written.

## Known Issues

**Test execution could not be verified in worktree**: The `pnpm install` command was persistently blocked by the permission system, preventing node_modules installation in the worktree. Tests follow established patterns from lock.test.ts and scheduler.test.ts and should pass when dependencies are available. Verification should be run after merge: `pnpm run test`.
