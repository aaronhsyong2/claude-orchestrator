---
plan_id: "07-04"
title: "TUI Shutdown Integration"
status: complete
started: 2026-05-04T00:30:00Z
completed: 2026-05-04T00:45:00Z
---

## Summary

Wired TUI dashboard to use file-based IPC for shutdown signaling. Single `q` writes graceful shutdown file, double-`q` within 2 seconds writes force shutdown file. Footer displays shutdown status with color-coded messages. Dashboard polls lock file after shutdown requested and auto-exits when orchestrator process terminates.

## Tasks Completed

| # | Task | Status |
|---|------|--------|
| 1 | Double-q detection in use-keyboard.ts + shutdown state in types.ts | ✓ |
| 2 | Footer shutdown status display + Dashboard prop threading | ✓ |

## Key Files

### Modified
- `src/tui/types.ts` — Added `ShutdownStatus` type and `shutdownStatus` to `DashboardState`
- `src/tui/use-keyboard.ts` — Double-q detection with 2s threshold, lock file polling via `useEffect`, graceful→force upgrade path, auto-exit on orchestrator termination
- `src/tui/Footer.tsx` — Shutdown status display with graceful/force/exited messages and yellow/red color coding
- `src/tui/Dashboard.tsx` — Threading `shutdownStatus` prop from `useKeyboard` to `Footer`

## Self-Check: PASSED

- `pnpm run check` — passes
- `pnpm run build` — passes
- All acceptance criteria met

## Deviations

None.
