# Phase 7 Context: Shutdown + Resume

**Date:** 2026-05-03
**Issue:** #18
**Branch:** feat/shutdown-resume
**Depends on:** PR 4 (Scheduler), PR 5 (TUI Dashboard), PR 6 (Resilience)

## Domain

Graceful lifecycle management — stop orchestration cleanly via IPC, resume from persisted state with git cross-referencing.

## Assumptions Audit Findings

Before discussion, we identified critical mismatches between the issue's acceptance criteria and the actual codebase:

1. **`dashboard` and `start` are separate processes** — issue assumes `q` press controls orchestration, but they're independent CLI commands with no communication channel. Resolved by choosing IPC mode (signal file).
2. **No cancellation mechanism in `assignWork()`** — uses `Promise.allSettled()` with no way to signal "stop accepting new work" mid-flight. Needs shutdown check points.
3. **Resume partially exists** — `processGroup()` already reads `issues_remaining` from disk (scheduler.ts:241-246), but `orchestrate()` creates fresh `mergedPRs = new Set()` and doesn't call `reconcile()`. Group-level phase resume doesn't exist.
4. **Signal handlers only release lock** — `installSignalHandlers()` in lock.ts calls `releaseLock()` then `process.exit(0)`. No state flush, no worker drain.

## Decisions

### IPC: Signal File + Polling
- Dashboard writes `.orchestrator/shutdown` file on `q` press
- File content: `{"mode": "graceful" | "force", "requested_at": "ISO timestamp"}`
- Orchestrator polls for this file between steps
- Single `q` → graceful mode. Double `q` within 2s → force mode
- Dashboard reads lock file to detect when orchestrator has exited, then auto-exits itself

### Shutdown Check Points: Between Issues Only
- Orchestrator checks shutdown signal after each `processIssue()` completes, before starting next issue
- Current issue always runs to completion (no mid-step interruption)
- On graceful shutdown: write status with `step_result: "interrupted"` for remaining issues, release lock, exit
- On force shutdown: SIGTERM all worker processes, best-effort state flush, release lock, exit
- No check points between group phases (self-review, PR creation, etc.) — keeps implementation simple

### Resume: Reset to Last Safe Checkpoint
- On `orchestrator start` with existing status files (no `--fresh`): treat as resume
- Call `reconcile()` before `assignWork()` to sync status with git state
- Detect already-merged PRs by checking git state / GitHub
- Resume decision tree:
  - `step == 'idle' && step_result == 'pass'` → all issues done → restart from self-review
  - `step in ['reviewing', 'pr-creating', 'pr-reviewing']` → died mid-phase → reset to idle, restart from self-review
  - `step == 'awaiting-merge'` → check if PR merged via reconcile → if merged: mark done, if not: resume merge wait
  - `step in ['coding', 'cloning', 'verifying']` → died mid-issue → restart current issue (already in `issues_remaining`)

### TUI Shutdown Feedback: Footer Status Line
- Replace footer hint text with shutdown status
- Graceful: `⏳ Shutting down — waiting for N worker(s)... (q again to force kill)`
- Force: `⚠ Force killing workers...`
- Dashboard polls lock file, auto-exits when orchestrator process gone

### GroupStep / Status Enhancements
- Add `step_result: "interrupted"` as documented shutdown state
- Existing `GroupStep` type sufficient — no new steps needed
- Status written atomically (already uses tmp+rename pattern)

### --fresh Flag
- Already implemented in `clearRuntimeState()` — deletes status/, context/, logs/, worktrees/
- No changes needed

### Signal Handlers
- Enhance `installSignalHandlers()` to flush state before exit
- SIGINT/SIGTERM: trigger graceful shutdown (write shutdown file for self, same code path)
- Direct Ctrl+C to orchestrator process (no dashboard): same graceful drain logic

## Code Context

### Files to Modify
- `src/cli.tsx` — add resume detection in `handleStart`, call `reconcile()` before orchestrate
- `src/lock.ts` — enhance signal handlers to trigger shutdown coordinator
- `src/scheduler.ts` — add shutdown check in `processGroup` loop, return `interrupted` result
- `src/orchestrate.ts` — pass shutdown signal through, handle interrupted results
- `src/tui/use-keyboard.ts` — change `q` to write shutdown file instead of exit
- `src/tui/Dashboard.tsx` — footer shutdown status, lock file polling for auto-exit
- `src/tui/launch.ts` — integrate shutdown state into dashboard loop

### New Files
- `src/shutdown.ts` — shutdown coordinator: read/write/poll shutdown file, force kill logic
- `src/resume.ts` — resume logic: reconcile + merged PR detection + checkpoint reset

### Existing Patterns to Follow
- Atomic file writes via tmp+rename (status-manager.ts:72-74)
- `SchedulerDeps` injection for testability
- Immutable status updates via spread (scheduler.ts throughout)
- `safeWriteStatus()` wrapper for error-safe I/O (scheduler.ts:108-115)

## Canonical Refs
- `docs/decisions/001-design-decisions.md` — 26 locked design decisions including "no daemon mode"
- `src/types.ts` — GroupStatus, GroupStep, SchedulerDeps interfaces
- `src/status-manager.ts` — reconcile() function, atomic write pattern
- `src/lock.ts` — current signal handler implementation
- `src/scheduler.ts` — processGroup loop, processIssue, assignWork
- `src/tui/use-keyboard.ts` — current q-press handling

## Out of Scope
- Detach/background mode (rejected in ADR 001)
- Daemon process management
- Mid-step interruption (coding step can't be cancelled gracefully)
- AbortSignal-based cooperative cancellation (too invasive for v1)
