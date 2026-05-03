---
title: "PR #24: Resilience Review"
category: review
tags:
  - resilience
  - retry
  - review-cycle
  - merge-detection
  - code-review
created: 2026-05-03
updated: 2026-05-03
status: active
related:
  - "[PR Plan](../guide/claude-orchestrator-pr-plan.md)"
  - "[PR #24](https://github.com/aaronhsyong2/claude-orchestrator/pull/24)"
---

# PR #24: Resilience — Review Summary

**Branch:** `feat/resilience`
**Issues:** #15, #16, #17
**Review cycles:** 6 (6 parallel agents per cycle)
**Final verdict:** APPROVE — 0 critical, 0 high

## Stats

- 23 files changed (+4,670 lines)
- 10 commits (3 feature + 4 fix + 3 refactor)
- 469 tests pass (27 test files)
- typecheck, lint, build all clean

## Review Agents Used

| Agent | Role |
|-------|------|
| code-reviewer | Bugs, security, race conditions |
| comment-analyzer | Comment accuracy, rot risk |
| pr-test-analyzer | Test coverage quality |
| silent-failure-hunter | Swallowed errors, bad fallbacks |
| type-design-analyzer | Type safety, invariant expression |
| code-simplifier | Duplication, complexity reduction |

## Issues Found and Resolved

### Round 1 (initial review)

| Severity | Issue | Resolution |
|----------|-------|------------|
| CRITICAL | CLOSED PR causes infinite hang in merge detector | Added `onComplete` callback with `MergeDetectorResult` ('merged'/'closed'/'timeout') |
| HIGH | `git commit -am` silently skips new files | Changed to `git add -A` + `git commit -m` |
| HIGH | False-positive merge detection via branch deletion | Added `merge-base --is-ancestor` check + `git fetch --prune` |
| HIGH | Unhandled async rejections in poll functions | Wrapped all async polls in try/catch |
| HIGH | `withBackoff` swallows error on final failure | Returns `BackoffResult<T>` discriminated union with captured `Error` |
| MEDIUM | `needs_input` vs `needs-input` spelling divergence | Aligned `FailureAction` to `'needs-input'` |
| MEDIUM | Notification failures silently swallowed | Added `.catch` with stderr logging on all notify calls |

### Round 2

| Severity | Issue | Resolution |
|----------|-------|------------|
| HIGH | Review worktree leaks on early return | Restructured `processGroup` to use `try/finally` |
| HIGH | Dirty tree after verify failure in pr-reviewer | Added `git checkout -- .` reset |
| HIGH | `VALID_STEPS` missing `pr-creating`, `pr-reviewing`, `awaiting-merge` | Added to status-manager validation |

### Round 3

| Severity | Issue | Resolution |
|----------|-------|------------|
| HIGH | `spawnWorker` rejects non-numeric issue IDs for review workers | Added `spawnDirectWorker` — direct prompt, no `/pick-up` wrapping |
| HIGH | Review prompt passed as `contextContent` instead of primary prompt | `spawnDirectWorker` bypasses `buildPrompt` entirely |
| MEDIUM | Self-reviewer doesn't reset dirty tree after failed fix | Added `execCommand` to `SelfReviewDeps`, added git checkout + clean |
| MEDIUM | `parsePRViewOutput` unguarded `JSON.parse` | Added try/catch with descriptive error |
| MEDIUM | `readContext` race between `existsSync` and `readFileSync` | Added try/catch returning null on failure |

### Round 4

| Severity | Issue | Resolution |
|----------|-------|------------|
| HIGH | `git checkout -- .` doesn't remove untracked files from fix worker | Added `git clean -fd` after checkout |

### Round 5 (refactoring)

- Extracted `spawnClaudeProcess` shared infrastructure (~85 lines deduped)
- Extracted `isBlocking`, `notifySafe`, `handleGitHubFailure` helpers

### Round 6 (final)

| Severity | Issue | Resolution |
|----------|-------|------------|
| HIGH | `schedulePoll` timer overwrite — concurrent poll loops possible | Added `clearTimeout` guard before setting new timer |
| HIGH | Self-reviewer skips commit enforcement after verified fix | Added `git add -A` + `git commit` matching pr-reviewer pattern |
| HIGH | Review worker crash — no diagnostic logged | Added stderr logging on non-zero exit in both reviewers |

## Accepted Trade-offs

### Test Coverage Gaps

- `review-helpers.ts` has no direct test file (covered indirectly via callers)
- `resolveRuleFileContents` path traversal guard untested
- `prReview` git push/commit failure paths untested
- Scheduler PR-closed/timeout paths untested
- Self-reviewer commit enforcement untested

### Type Design

- `GroupStatus.step_result: string` — stringly-typed protocol (accepted, would require large refactor)
- `RetryResult` flat struct allows contradictory states (accepted, convention-enforced)
- `SchedulerDeps` doesn't explicitly extend `WorkerCapableDeps` (accepted)

### Known Limitations

- `spawnAndCapture` error event resolves as exit-1, losing original error object
- `--allow-empty` on self-reviewer commit may produce empty commits in PR history
- `parseJsonArray` greedy regex may truncate multi-item LLM responses
