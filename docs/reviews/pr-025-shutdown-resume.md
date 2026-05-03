---
title: "PR #25: Shutdown + Resume Review"
category: review
tags:
  - shutdown
  - resume
  - graceful-shutdown
  - signal-handling
  - code-review
created: 2026-05-04
updated: 2026-05-04
status: active
related:
  - "[PR Plan](../guide/claude-orchestrator-pr-plan.md)"
  - "[PR #25](https://github.com/aaronhsyong2/claude-orchestrator/pull/25)"
---

# PR #25: Shutdown + Resume — Review Summary

**Branch:** `feat/resilience`
**Issues:** #18
**Review cycles:** 4 (6 parallel agents per cycle)
**Final verdict:** APPROVE — 0 critical, 0 high

## Stats

- 28 files changed (+3,330 lines)
- 1 squashed commit
- 515 tests pass (29 test files)
- typecheck, lint, build all clean

## What Was Built

- **Shutdown coordinator** (`src/shutdown.ts`) — file-based IPC shutdown signaling with atomic write, worker PID registry, force-kill support
- **Resume module** (`src/resume.ts`) — detects existing state, reconciles with git, detects merged PRs via `gh`, resets to safe checkpoints
- **Scheduler integration** (`src/scheduler.ts`) — shutdown checkpoint between issues, `step_result: 'interrupted'` on graceful stop
- **Signal handlers** (`src/lock.ts`) — `onShutdown` callback with re-entrancy guard, SIGTERM/SIGINT registration
- **Orchestrate wiring** (`src/orchestrate.ts`) — worker registry, resume detection, force kill, graceful shutdown callback
- **CLI integration** (`src/cli.tsx`) — shutdown file IPC, resume detection logging, `--fresh` flag
- **TUI integration** (`src/tui/`) — `q` writes graceful, double-`q` within 2s writes force, footer shows status, auto-exit on orchestrator termination

## Review Rounds

### Round 1 — Focused code review
- 2 HIGH: temporal dead zone in worker wrappers, leaked setTimeout in poll effect
- 4 MEDIUM: swallowed catches (readShutdownFile, hasExistingState), missing shutdownStatus in test fixture, writeShutdownFile unhandled in TUI
- **All fixed**

### Round 2 — Full 6-agent review
- 2 HIGH: redundant clearShutdownFile timing window, buildGitState unchecked exitCode
- 3 MEDIUM: useEffect re-entry after exited, misleading comment, writeShutdownFile unhandled in signal callback
- **All fixed** (except awaiting-merge 24h block — tracked as design follow-up)

### Round 3 — Full 6-agent review
- 1 HIGH: auto-exit timeout cancelled by React effect cleanup (dashboard never closes)
- 1 HIGH: resumeFromState unhandled throw aborts completely
- **Both fixed** — separated polling and auto-exit into two effects; wrapped resume in try/catch with fresh-start fallback

### Round 4 — Full 6-agent review
- 0 new bugs found
- Advisory items only (simplifications, type design, comments)
- **Clean**

## Tracked Follow-ups (not blocking)

- `awaiting-merge` phase has no shutdown check (24h block) — design follow-up
- Test gaps: double-q force upgrade, Footer rendering, resumeFromState integration
- Advisory: GroupResult discriminated union, wrapSpawnWorker dedup, stale RESEARCH.md refs
