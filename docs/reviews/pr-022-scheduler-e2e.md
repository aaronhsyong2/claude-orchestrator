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
**Commits:** `88cb805` (Issue #9), `51efe9d` (Issue #10)
**Reviewers:** 6 automated agents (code-reviewer, silent-failure-hunter, type-design-analyzer, pr-test-analyzer, comment-analyzer, security-reviewer)
**Date:** 2026-05-03

## Changes

| File | Lines | Purpose |
|------|-------|---------|
| `src/scheduler.ts` | +262 | Core scheduling: `getReadyGroups`, `assignWork`, `onMerge`, serial issue processing per group |
| `src/orchestrate.ts` | +93 | Composition layer — builds real `SchedulerDeps`, progress emission via `writeGroupStatus` wrapper |
| `src/slug.ts` | +24 | Deterministic filesystem-safe slug derivation from branch names |
| `src/types.ts` | +33 | `SchedulerDeps`, `GroupResult`, `AssignWorkResult`, `WorkerHandle` types |
| `src/cli.tsx` | +15/−6 | Wired `handleStart` to orchestrate, non-zero exit on failure, lock release in finally |
| `src/worktree-manager.ts` | +10/−30 | Switched to slug-based worktree paths |
| `src/scheduler.test.ts` | +446 | 28 unit tests |
| `src/orchestrate.test.ts` | +290 | 9 integration tests |
| `src/slug.test.ts` | +36 | 8 unit tests |

## Verdict

**5 HIGH issues warrant fixing before merge.** Most pressing: worktree leak, `Promise.all` orphan risk, and I/O crash propagation. Security items are lower likelihood but high impact if exploited.

---

## HIGH — 5

### 1. Worktree leak — `removeWorktree` never called

**File:** `src/scheduler.ts` — `processIssue`

`SchedulerDeps` defines `removeWorktree` and `orchestrate.ts` wires it to `realRemove`, but `processIssue` never calls `deps.removeWorktree(group.branch)` after successful verification. Every issue run creates a worktree at `.orchestrator/worktrees/<slug>` that is never removed. Over a long plan this exhausts disk space and leaves git worktrees registered in the repo.

**Fix:** Add cleanup in a `finally` block after each issue completes (both success and failure paths).

### 2. `Promise.all` rejects on first throw, orphaning sibling workers

**File:** `src/scheduler.ts:237`

If `processGroup` throws (e.g., I/O error in `writeGroupStatus`), `Promise.all` rejects immediately. Other groups' spawned `claude` processes are orphaned with no cleanup path.

**Fix:** Use `Promise.allSettled` and map rejected promises to `{ completed: false }` results.

### 3. `writeGroupStatus` I/O errors crash entire orchestration

**File:** `src/scheduler.ts`

All `writeGroupStatus` calls are unwrapped. Any I/O error (disk full, permissions) throws synchronously, propagates into `Promise.all`, and cancels all sibling groups.

**Fix:** Wrap status writes in try/catch or make the status-manager resilient to transient failures.

### 4. Branch name git argument injection

**File:** `src/worktree-manager.ts:66,75`

Branch names like `--upload-pack=cmd` pass current validation. `execFileSync` prevents shell injection but not git argument injection.

**Fix:** Validate branch names with `^[a-zA-Z0-9._\-/]+$` and reject `--` prefix.

### 5. `exec()` runs config-sourced commands via `/bin/sh` without content validation

**File:** `src/verification.ts:48`

`verify` commands from `config.json` are passed to `exec()` (shell mode) with no content validation. Compromised config = arbitrary code execution.

**Fix:** Switch to `execFile` with split args, or validate commands against a safe-character regex.

---

## MEDIUM — 5

### 6. `readGroupStatus` returns null on corruption, causing silent re-processing

**File:** `src/status-manager.ts` → `src/scheduler.ts:43`

Corrupt status file returns `null`, `freshStatus` reinitializes, completed issues get re-processed.

**Fix:** Distinguish "file missing" (init OK) from "file corrupt" (throw/halt).

### 7. `deleteContext` failure prevents completion recording

**File:** `src/scheduler.ts:155`

`deleteContext` is called before `writeGroupStatus` records success. If `deleteContext` throws, completed issue never gets recorded and will be re-run.

**Fix:** Record completion first, then delete context.

### 8. `process.exit(1)` inside try block bypasses finally

**File:** `src/cli.tsx:69`

`process.exit` bypasses `finally` block. Mitigated by `'exit'` event handler, but confusing code.

**Fix:** Move exit after `finally` block.

### 9. `baseBranch` validation weaker than `branch` validation

**File:** `src/worktree-manager.ts:46-51`

`resolvedBase` uses ad-hoc check (allows `" main"` with whitespace) instead of `deriveSlug` validation. Regression from prior code.

**Fix:** Apply same validation to `resolvedBase`.

### 10. `max_concurrent_agents` unbounded

**File:** `src/config.ts`

Only checks `typeof === 'number'`. Config value of 10000 spawns 10000 `claude` processes.

**Fix:** Bound to `1–20` in `validateConfig`.

---

## LOW / ADVISORY — 5

### 11. "Starting PR" over-emission

**File:** `src/orchestrate.ts:41-46`

Emits "Starting" for all ready groups but only `max_concurrent_agents` are actually worked on. Misleading output.

### 12. Double-resolve race in spawnWorker promise

**File:** `src/scheduler.ts:93-108`

Both `'error'` and `'exited'` events can fire for same process. Safe by coincidence (first settlement wins) but fragile.

### 13. `emitProgress` skips `cloning` step

**File:** `src/orchestrate.ts:74-93`

No progress emission during worktree creation. UX gap in slow environments.

### 14. Slug collision not detected at runtime

**File:** `src/slug.ts`

Documented but unenforced. Two groups with `feat/auth` and `feat-auth` would corrupt each other's state.

### 15. `step_result` magic string `'pass'`

**File:** `src/orchestrate.ts:83`

Business logic depends on `step_result === 'pass'` — invisible at type level. Should be typed sentinel.

---

## Test Gaps

| Gap | Description | Priority |
|-----|-------------|----------|
| Resume path | No test pre-seeds `readGroupStatus` with partial completion | Important |
| Mixed outcomes | No multi-group test with one failing, one succeeding in `Promise.all` | Important |
| Uppercase slug | `deriveSlug('FEAT/BRANCH')` not covered (works but unpinned) | Nice-to-have |

---

## Type Design Notes

| Issue | Location | Recommendation |
|-------|----------|----------------|
| `GroupStatus` should be discriminated union | `types.ts:85-96` | Model step ↔ current_issue correlation |
| `WorkerEvent` callback loose union | `types.ts:118-124` | Replace with discriminated union, eliminate `as` casts |
| `GroupResult` flat boolean | `types.ts:133-139` | Discriminated union for success vs failure shapes |
| `'merging'` dead member | `types.ts:83` | Remove from `GroupStep` until used |
| `assigned` redundant | `types.ts:141-144` | `assigned` always equals `results.length` |
| `isValidGroupStatus` array check | `status-manager.ts:23-39` | Doesn't validate array elements are numbers |

---

## Comment Quality

| Issue | Location |
|-------|----------|
| "Total active workers = ... not max_concurrent_agents" misleading | `scheduler.ts:232-234` |
| TOCTOU comments split across two files with no canonical enforcement point | `slug.ts` + `worktree-manager.ts` |
| `// cloning`, `// coding`, `// verifying` restate field values verbatim | `scheduler.ts:55,81,132` |
| `deriveSlug(branch)` comment lists 2 of 3 validation cases | `worktree-manager.ts:44` |
