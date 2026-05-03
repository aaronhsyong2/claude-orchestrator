---
phase: 7
plan: "07-01"
subsystem: shutdown
tags:
  - shutdown
  - ipc
  - file-based-signaling
  - worker-registry
dependency_graph:
  requires: []
  provides:
    - ShutdownMode type
    - ShutdownSignal interface
    - shouldShutdown on SchedulerDeps
    - shutdown coordinator module (read/write/poll/clear)
    - WorkerRegistry interface
    - forceKillAll function
  affects:
    - src/types.ts
tech_stack:
  added: []
  patterns:
    - atomic-write-tmp-rename
    - dependency-injection-callback
    - encapsulated-set-registry
key_files:
  created:
    - src/shutdown.ts
  modified:
    - src/types.ts
decisions:
  - "WorkerRegistry uses encapsulated Set with register/deregister/getActivePids -- no external mutation"
  - "forceKillAll accepts injected killWorker callback instead of importing worker-manager directly"
  - "readShutdownFile validates mode strictly, returns null on any parse or validation error"
  - "writeShutdownFile uses tab-indented JSON with trailing newline matching status-manager pattern"
metrics:
  duration_seconds: 89
  completed: "2026-05-03T16:11:32Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 7 Plan 01: Shutdown Coordinator Module Summary

Shutdown coordinator module with file-based IPC signaling and worker PID registry for graceful/force shutdown orchestration.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Extend types.ts with shutdown types | d72c8c6 | Added ShutdownMode, ShutdownSignal, shouldShutdown on SchedulerDeps |
| 2 | Create src/shutdown.ts | 8ad11e3 | 6 exports: getShutdownPath, writeShutdownFile, readShutdownFile, clearShutdownFile, createWorkerRegistry, forceKillAll |

## Implementation Details

### Types (src/types.ts)

- `ShutdownMode`: Union type `'graceful' | 'force'`
- `ShutdownSignal`: Readonly interface with `mode` and `requested_at` fields
- `shouldShutdown`: Optional callback on `SchedulerDeps` returning `ShutdownSignal | null`; callers use `deps.shouldShutdown?.()` with optional chaining

### Shutdown Coordinator (src/shutdown.ts)

- `getShutdownPath(baseDir?)`: Resolves `.orchestrator/shutdown` path
- `writeShutdownFile(mode, baseDir?)`: Atomic write via tmp+rename, tab-indented JSON
- `readShutdownFile(baseDir?)`: Safe read with strict mode validation, null on any error
- `clearShutdownFile(baseDir?)`: Unlink with ENOENT suppression
- `createWorkerRegistry()`: Encapsulated Set-based PID tracker with register/deregister/getActivePids
- `forceKillAll(registry, killWorker)`: Promise.allSettled over all active PIDs, delegates to injected killWorker

## Verification

```
pnpm run check: Checked 68 files -- no errors
pnpm run build: ESM build success
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Biome formatting for Promise.allSettled call**
- **Found during:** Task 2
- **Issue:** Biome formatter expected single-line `Promise.allSettled(registry.getActivePids().map(...))` instead of multi-line
- **Fix:** Collapsed to single line to match project formatter rules
- **Files modified:** src/shutdown.ts
- **Commit:** 8ad11e3

## Self-Check: PASSED
