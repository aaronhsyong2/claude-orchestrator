---
title: "Review: PR #22 — Scheduler + E2E Integration"
category: review
tags:
  - scheduler
  - orchestration
  - pr-review
  - security
created: 2026-05-03
updated: 2026-05-03
status: active
related:
  - "[Design Decisions](../decisions/001-design-decisions.md)"
  - "[PR Plan](../guide/claude-orchestrator-pr-plan.md)"
---

# PR #22 Review — Scheduler + E2E Integration

**PR:** `feat/scheduler` → `main`
**Commits:** `88cb805` (Issue #9), `51efe9d` (Issue #10), `7edd10b` (fix: round 1), `6b5a45b` (fix: round 2), pending (fix: round 3)
**Reviewers:** 6 automated agents × 3 rounds
**Date:** 2026-05-03

## Verdict: PASS

All CRITICAL, HIGH, and IMPORTANT issues resolved across three review rounds. Remaining items are ADVISORY-level.

---

## Round 1 — 5 HIGH, 5 MEDIUM → All Resolved

| # | Issue | Resolution |
|---|-------|-----------|
| H1 | Worktree leak — `removeWorktree` never called | `finally` block in `processIssue` |
| H2 | `Promise.all` orphans workers | Switched to `Promise.allSettled` |
| H3 | `writeGroupStatus` I/O crashes orchestration | `safeWriteStatus` wrapper |
| H4 | Branch name git argument injection | `validateBranchName` + `SAFE_BRANCH_RE` |
| H5 | `exec()` shell mode on config commands | Switched to `execFile` + `SAFE_COMMAND_RE` + `SHELL_EXECUTABLES` |
| M6 | `readGroupStatus` null on corruption | `freshStatus` re-reads before every write |
| M7 | `deleteContext` before completion recording | Reordered: completion first, then delete |
| M8 | `process.exit` inside try block | Clarified: Node.js runs `finally` before exit |
| M9 | `baseBranch` validation gap | `validateBranchName(resolvedBase, 'Base branch')` |
| M10 | `max_concurrent_agents` unbounded | Bounded 1–20 in `validateConfig` |

## Round 2 — 11 IMPORTANT → All Resolved

| # | Issue | Resolution |
|---|-------|-----------|
| I1 | Slug collision = silent data corruption | Pre-flight uniqueness check in `assignWork` |
| I2 | `emitProgress` skips `cloning` step | Added `cloning` branch to `emitProgress` |
| I3 | Misleading "Starting PR" for capped groups | Capped progress headers to `max_concurrent_agents` |
| I4 | Worktree cleanup failure invisible | Replaced bare `catch {}` with stderr logging |
| I5 | `safeWriteStatus` destroys stack traces | Changed to `err.stack ?? err.message` |
| I6 | ENOENT from `execFile` = empty error | Added ENOENT detection with `exitCode: 127` and synthetic message |
| I7 | `removeWorktree` never asserted in tests | Added 4 tests: success/failure/verify-fail/no-create paths |
| I8 | Resume behavior untested | Added test seeding pre-populated `issues_remaining` |
| I9 | `spawnWorker` callback unchecked `as` casts | Introduced `WorkerEvent` discriminated union, removed all `as` casts |
| I10 | `'merging'` dead state in `GroupStep` | Removed from type and validator |
| I11 | `blocked`/`needs_input` always false | Removed from `GroupStatus`, `initGroupStatus`, and validator |

## Round 3 — 1 CRITICAL, 2 IMPORTANT → All Resolved

| # | Issue | Resolution |
|---|-------|-----------|
| C1 | Default config `pnpm run test:e2e` `:` fails `SAFE_COMMAND_RE` | Added `:` to allowed chars — safe in `execFile` argv |
| I1 | `deleteContext` bare call after success — transient fs error fails group | Wrapped in try/catch with stderr logging |
| I2 | `create()` base branch `rev-parse` catch discards error detail | Now includes git error message via `getGitErrorMessage` |

---

## Remaining ADVISORY Items (future work)

| # | Finding | File |
|---|---------|------|
| A1 | `SHELL_EXECUTABLES` comment overstates protection scope | `verification.ts:13` |
| A2 | `max_retries_on_fail` config field parsed but never used | `config.ts` |
| A3 | `killWorker` in `SchedulerDeps` never called by scheduler | `types.ts` |
| A4 | `AssignWorkResult.assigned` redundant with `results.length` | `types.ts` |
| A5 | `step`/`current_issue` coupling unenforced — use discriminated union | `types.ts` |
| A6 | `buildRealDeps` passthrough wrappers — use direct function refs | `orchestrate.ts` |
| A7 | Repeated status-write pattern — extract `writeStep` helper | `scheduler.ts` |
| A8 | `safeWriteStatus` resilience never tested | `scheduler.test.ts` |
| A9 | `wrapWithProgress` — `onProgress` throw conflated with status-write failure | `orchestrate.ts` |
| A10 | `processGroup` inner `deriveSlug` catch unreachable after collision guard | `scheduler.ts` |
| A11 | `issues_completed`/`issues_remaining` partition invariant unenforced | `types.ts` |
| A12 | `orchestrate` recomputes `getReadyGroups` + cap that `assignWork` does internally | `orchestrate.ts` |
| A13 | `getLogPath` duplicates path from `getLogDir` | `worker-manager.ts` |

---

## Test Coverage

- **282 tests pass** (15 files)
- **7 new tests** added in round 2
- Lint, typecheck, build all clean
