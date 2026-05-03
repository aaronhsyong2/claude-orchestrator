---
title: "PR #23: TUI Dashboard Review"
category: review
tags:
  - tui
  - dashboard
  - code-review
created: 2026-05-03
updated: 2026-05-03
status: active
related:
  - "[PR Plan](../guide/claude-orchestrator-pr-plan.md)"
  - "[PR #23](https://github.com/aaronhsyong2/claude-orchestrator/pull/23)"
---

# PR #23: TUI Dashboard — Review Summary

**Branch:** `feat/tui-dashboard`
**Issues:** #11, #12, #13, #14
**Review cycles:** 4 (6 parallel agents per cycle)
**Final verdict:** APPROVE — 0 critical, 0 high

## Stats

- 42 files changed (+5,404 lines)
- 6 commits (4 feature + 2 fix)
- 384 tests pass (22 test files)
- typecheck, lint, build all clean

## Review Agents Used

Each cycle ran 6 agents in parallel:
- code-reviewer
- comment-analyzer
- pr-test-analyzer
- silent-failure-hunter
- type-design-analyzer
- code-simplifier

## Issues Fixed (Rounds 1-3)

### Critical (2)
1. **AppleScript injection** — message interpolated into osascript string → now passed as argv argument
2. **Unawaited `launchDashboard()`** — async promise dropped in cli.tsx → now awaited

### High (4)
3. **First-render notification storm** — `prevResultsRef` empty on mount → `initializedRef` guard
4. **Stale closure in `currentState()`** — render-closure values → `stateRef` synced via `useEffect`
5. **Sync I/O in async poll** — `readLatestLogLines` and `listGroupSlugs` → fully async (`fs.promises`)
6. **Per-slug error isolation** — single bad status file killed entire poll → per-slug try/catch

### Important (8)
7. Module-level mutable `nextEventId` → immutable `deriveActivity` returning `{ events, nextId }`
8. No error handling in `poll()` → try/catch with stderr logging
9. `readLatestLogLines` swallowed errors → surfaced in UI as "Log read failed"
10. Signal-killed takeover resolved as success → reject with signal info
11. `step_result` prefix matching → extracted named constants
12. `activePanel: number` → `PanelIndex` (0 | 1 | 2)
13. Unused `_level` param in `notify()` → removed
14. Error auto-dismiss `setTimeout` not cancelled → `useEffect` cleanup

### Medium (5)
15. Duplicated issue-icon logic → extracted `getIssueIcon()`
16. Duplicated `selectedGroup` derivation → passed directly as prop
17. Duplicated takeover trigger (Enter/v) → unified handler
18. Dead `pipe` variable in DependencyGraphView → removed
19. `SHELL` env var validated as absolute path

## Tests Added

- `deriveActivity` — 7 tests (new group, step change, null issue, no-change, mixed)
- `detectTransition` — 9 tests (all step_result patterns)
- `useNotifications` hook — 4 tests (first-render guard, fire on change, dedup, non-notification)
- SHELL validation — 1 test (non-absolute path fallback)

## Accepted Follow-Up Items

These were identified but not blocking merge:

| Item | Severity |
|------|----------|
| Alt-buffer cleanup on SIGTERM/SIGHUP | Medium |
| `SidebarProps`/`FooterProps` should use `PanelIndex` | Medium |
| `readGroupStatus` sync I/O (shared module) | Medium |
| `step_result: string` → discriminated union | Medium |
| Config ref stability (latent, not current bug) | Medium |
| Log file ordering assumption (lexicographic) | Low |
| `launchDashboard` lifecycle tests | Low |
| State snapshot test for takeover restoration | Low |
| Issue wrap-around navigation tests | Low |
| `getIssueIcon` direct tests | Low |
