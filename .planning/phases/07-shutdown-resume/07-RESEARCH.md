# Phase 7: Shutdown + Resume - Research

**Researched:** 2026-05-03
**Domain:** Process lifecycle management, file-based IPC, cooperative shutdown, state reconciliation
**Confidence:** HIGH

## Summary

This phase adds graceful shutdown and auto-resume to the orchestrator. The core mechanism is file-based IPC: the dashboard writes a `.orchestrator/shutdown` signal file, and the orchestrator process polls for it between `processIssue()` calls. Two shutdown modes exist: graceful (finish current issue, flush state, exit) and force (SIGTERM all workers, best-effort flush, exit). Resume detects existing status files on startup and reconciles them against git/GitHub state before continuing.

The codebase already has strong foundations: atomic file writes via tmp+rename in `status-manager.ts`, a polling pattern in `use-status-poller.ts` and `merge-detector.ts`, `killWorker()` with SIGTERM-then-SIGKILL escalation in `worker-manager.ts`, and dependency injection via `SchedulerDeps` for testability. The primary engineering challenge is threading shutdown awareness through the `processGroup` loop in `scheduler.ts` without breaking the existing `Promise.allSettled` concurrency model.

**Primary recommendation:** Implement shutdown as a pure-function coordinator module (`src/shutdown.ts`) that reads/writes/polls the signal file, and a resume module (`src/resume.ts`) that wraps reconcile + merged-PR detection + checkpoint reset. Thread a `shouldShutdown()` callback through `SchedulerDeps` so the scheduler can check between issues without direct file I/O coupling.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- IPC: Signal file + polling (`.orchestrator/shutdown`), file content: `{"mode": "graceful" | "force", "requested_at": "ISO timestamp"}`
- Dashboard writes shutdown file on `q` press; single `q` = graceful, double `q` within 2s = force
- Orchestrator polls for shutdown file between steps (after each `processIssue()`)
- Current issue always runs to completion (no mid-step interruption)
- Graceful: write status with `step_result: "interrupted"` for remaining issues, release lock, exit
- Force: SIGTERM all workers, best-effort state flush, release lock, exit
- No check points between group phases (self-review, PR creation, etc.)
- Resume: on `orchestrator start` with existing status files (no `--fresh`), treat as resume
- Call `reconcile()` before `assignWork()` to sync status with git state
- Detect already-merged PRs by checking git state / GitHub
- Resume decision tree defined in CONTEXT.md (idle+pass -> restart from self-review, mid-phase -> reset to idle, awaiting-merge -> check PR, mid-issue -> restart current issue)
- TUI: Footer status line for shutdown feedback
- Dashboard polls lock file, auto-exits when orchestrator process gone
- Add `step_result: "interrupted"` as documented shutdown state
- Enhance `installSignalHandlers()` to flush state before exit (SIGINT/SIGTERM trigger graceful shutdown)
- `--fresh` flag: no changes needed (already implemented)

### Claude's Discretion
- Internal implementation details of shutdown coordinator
- Polling interval for shutdown file
- How to thread shutdown signal through scheduler
- Resume helper internals
- Test strategy details

### Deferred Ideas (OUT OF SCOPE)
- Detach/background mode (rejected in ADR 001)
- Daemon process management
- Mid-step interruption (coding step cannot be cancelled gracefully)
- AbortSignal-based cooperative cancellation (too invasive for v1)
</user_constraints>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Shutdown signal file I/O | Shutdown coordinator (`src/shutdown.ts`) | -- | Centralized read/write/poll of `.orchestrator/shutdown` |
| Graceful drain (finish current issue) | Scheduler (`src/scheduler.ts`) | -- | `processGroup` loop owns the issue iteration; shutdown check goes between iterations |
| Force kill workers | Shutdown coordinator | Worker manager | Coordinator decides to kill; delegates to existing `killWorker()` |
| State flush on shutdown | Scheduler | Status manager | Scheduler writes `step_result: "interrupted"` via existing `safeWriteStatus` |
| Resume detection | CLI (`src/cli.tsx`) | -- | `handleStart` detects existing status files before calling orchestrate |
| Reconciliation + PR detection | Resume module (`src/resume.ts`) | Status manager | New module wraps `reconcile()` + `gh pr view` checks |
| Dashboard shutdown feedback | TUI (Footer, use-keyboard) | -- | Footer shows shutdown status; `q` press writes signal file |
| Lock file polling (auto-exit) | TUI (Dashboard/launch) | Lock module | Dashboard polls `readLock()` to detect orchestrator exit |
| Signal handler enhancement | Lock module (`src/lock.ts`) | Shutdown coordinator | Signal handlers trigger shutdown coordinator instead of raw exit |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node:fs | built-in | Signal file I/O, atomic writes | Already used throughout codebase for status/lock files [VERIFIED: codebase] |
| node:child_process | built-in | Worker process management | Already used in worker-manager.ts [VERIFIED: codebase] |
| ink | ^7.0.0 | TUI framework (useInput, useApp) | Already the project's TUI framework [VERIFIED: package.json] |
| react | ^19.0.0 | Component model for TUI | Already the project's UI layer [VERIFIED: package.json] |
| vitest | ^3.0.0 | Test framework | Already configured in vitest.config.ts [VERIFIED: codebase] |

### Supporting
No new dependencies needed. This phase uses only Node.js built-ins and existing project dependencies.

## Architecture Patterns

### System Architecture Diagram

```
Dashboard Process                    Orchestrator Process
==================                   ====================

[q press] ──────────────────────────────────────────────────┐
     │                                                       │
     v                                                       │
writeShutdownFile()                                          │
  ".orchestrator/shutdown"                                   │
  {"mode":"graceful","requested_at":"..."}                   │
     │                                                       │
     │         ┌─────────────────────────────────────────────┘
     │         │
     │         v
     │    pollShutdownFile() ◄── called between processIssue() calls
     │         │
     │         ├── graceful ──► finish current issue
     │         │                  │
     │         │                  v
     │         │              write "interrupted" for remaining issues
     │         │                  │
     │         │                  v
     │         │              releaseLock() + process.exit()
     │         │
     │         └── force ────► SIGTERM all workers
     │                           │
     │                           v
     │                        best-effort state flush
     │                           │
     │                           v
     │                        releaseLock() + process.exit()
     │
     v
[poll lockFile] ──► lock gone? ──► auto-exit dashboard


Resume Flow (orchestrator start):
=================================

handleStart()
     │
     ├── --fresh? ──► clearRuntimeState() ──► normal start
     │
     └── existing status files? ──► resume path
              │
              v
         reconcile(gitState)         ← fix stale statuses
              │
              v
         detectMergedPRs()           ← gh pr view for awaiting-merge groups
              │
              v
         resetCheckpoints()          ← apply resume decision tree
              │
              v
         assignWork(plan, mergedPRs) ← normal scheduler with updated state
```

### Recommended Project Structure
```
src/
├── shutdown.ts          # NEW: shutdown coordinator (read/write/poll signal file)
├── resume.ts            # NEW: resume logic (reconcile + PR detection + checkpoint reset)
├── scheduler.ts         # MODIFY: add shouldShutdown check in processGroup loop
├── orchestrate.ts       # MODIFY: pass shutdown signal, handle interrupted results
├── lock.ts              # MODIFY: enhance signal handlers to trigger shutdown
├── cli.tsx              # MODIFY: add resume detection in handleStart
├── types.ts             # MODIFY: add ShutdownMode type, extend SchedulerDeps
├── tui/
│   ├── use-keyboard.ts  # MODIFY: q writes shutdown file, double-q detection
│   ├── Dashboard.tsx     # MODIFY: pass shutdown state to Footer
│   ├── Footer.tsx        # MODIFY: conditional shutdown status display
│   └── launch.ts         # MODIFY: lock file polling for auto-exit
```

### Pattern 1: Shutdown Coordinator Module
**What:** A stateless module that encapsulates all shutdown signal file operations.
**When to use:** Any component that needs to read, write, or poll the shutdown signal.

```typescript
// src/shutdown.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ShutdownMode = 'graceful' | 'force';

export interface ShutdownSignal {
  readonly mode: ShutdownMode;
  readonly requested_at: string;
}

export function getShutdownPath(baseDir?: string): string {
  return path.resolve(baseDir ?? '.', '.orchestrator/shutdown');
}

export function writeShutdownFile(mode: ShutdownMode, baseDir?: string): void {
  const filePath = getShutdownPath(baseDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const signal: ShutdownSignal = {
    mode,
    requested_at: new Date().toISOString(),
  };
  // Atomic write via tmp+rename (same pattern as status-manager.ts:72-74)
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(signal, null, '\t'));
  fs.renameSync(tmpPath, filePath);
}

export function readShutdownFile(baseDir?: string): ShutdownSignal | null {
  const filePath = getShutdownPath(baseDir);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as ShutdownSignal;
    if (parsed.mode === 'graceful' || parsed.mode === 'force') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearShutdownFile(baseDir?: string): void {
  try {
    fs.unlinkSync(getShutdownPath(baseDir));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
```
[VERIFIED: codebase patterns from status-manager.ts and lock.ts]

### Pattern 2: Threading Shutdown Through SchedulerDeps
**What:** Add a `shouldShutdown` callback to `SchedulerDeps` so the scheduler checks for shutdown without direct file I/O.
**When to use:** Between `processIssue()` calls in the `processGroup` loop.

```typescript
// Addition to SchedulerDeps interface in types.ts
export interface SchedulerDeps {
  // ... existing fields ...
  readonly shouldShutdown?: () => ShutdownSignal | null;
}

// In scheduler.ts processGroup loop:
for (const issueNumber of remaining) {
  // Check for shutdown BEFORE starting next issue
  const shutdownSignal = deps.shouldShutdown?.();
  if (shutdownSignal) {
    // Write interrupted status for remaining issues
    safeWriteStatus(deps, slug, {
      ...freshStatus(slug, group, deps, now),
      current_issue: null,
      step: 'idle',
      step_result: 'interrupted',
      last_updated: now(),
    });
    return { completed: false, error: `shutdown: ${shutdownSignal.mode}` };
  }

  const result = await processIssue(group, issueNumber, slug, config, deps, now);
  if (!result.success) {
    return { completed: false, failedIssue: issueNumber, error: result.error };
  }
}
```
[VERIFIED: codebase pattern from scheduler.ts:248-254 and types.ts SchedulerDeps]

### Pattern 3: Double-Keypress Detection in React/Ink
**What:** Track last `q` press timestamp with `useRef`, compare on second press.
**When to use:** In `use-keyboard.ts` for graceful vs force shutdown selection.

```typescript
// In use-keyboard.ts
const lastQPressRef = useRef<number>(0);
const DOUBLE_Q_THRESHOLD_MS = 2000;

// Inside useInput callback:
if (input === 'q') {
  const now = Date.now();
  const elapsed = now - lastQPressRef.current;
  lastQPressRef.current = now;

  if (elapsed < DOUBLE_Q_THRESHOLD_MS) {
    // Double q -> force shutdown
    writeShutdownFile('force', baseDir);
  } else {
    // Single q -> graceful shutdown
    writeShutdownFile('graceful', baseDir);
  }
  return;
}
```
[VERIFIED: useRef pattern already used in use-keyboard.ts:83 (stateRef), Ink useInput API from Context7]

### Pattern 4: Lock File Polling for Dashboard Auto-Exit
**What:** Dashboard polls the lock file to detect when the orchestrator process has exited.
**When to use:** After shutdown signal is written, dashboard waits for orchestrator to finish.

```typescript
// In Dashboard.tsx or a new hook
const [shutdownState, setShutdownState] = useState<ShutdownSignal | null>(null);

useEffect(() => {
  const timer = setInterval(() => {
    // Check if shutdown was requested
    const signal = readShutdownFile(baseDir);
    setShutdownState(signal);

    // Check if orchestrator is gone
    if (signal) {
      const pid = readLock(baseDir);
      if (pid === null || !isProcessAlive(pid)) {
        // Orchestrator exited - auto-exit dashboard
        exit();
      }
    }
  }, 1000);
  return () => clearInterval(timer);
}, [baseDir, exit]);
```
[VERIFIED: readLock/isProcessAlive from lock.ts, useEffect polling pattern from use-status-poller.ts]

### Anti-Patterns to Avoid
- **fs.watch for signal file detection:** Platform-dependent behavior, race conditions with atomic rename, unnecessary complexity. Use polling instead -- the orchestrator already polls status files at 2s intervals. [CITED: https://nodejs.org/api/fs.html#caveats]
- **process.on instead of process.once for signals:** Multiple handlers firing causes double-shutdown. Use `process.once` with a shutdown guard flag. [VERIFIED: current code uses process.once in lock.ts:84-86]
- **Mutating shutdown state in the scheduler:** Use immutable patterns. The `shouldShutdown` callback returns a fresh read each time; no shared mutable state.
- **AbortController threading:** Too invasive for v1 per CONTEXT.md decision. The between-issue polling is sufficient and much simpler.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Manual write+fsync | tmp+rename pattern | Already proven in status-manager.ts; rename is atomic on POSIX [VERIFIED: codebase] |
| Process kill escalation | Custom SIGTERM/SIGKILL logic | Existing `killWorker()` | Already implements SIGTERM -> 5s timeout -> SIGKILL with polling [VERIFIED: worker-manager.ts:208-250] |
| Status file validation | Manual JSON parsing | Existing `readGroupStatus()` | Already validates schema, handles malformed files [VERIFIED: status-manager.ts:26-39] |
| PR merge detection | Custom GitHub API calls | Existing `gh pr view` pattern | merge-detector.ts already handles GitHub API + git fallback [VERIFIED: codebase] |
| File-based polling | Custom setInterval wrapper | Follow merge-detector.ts timer pattern | stopped/completed guards, clearTimers cleanup [VERIFIED: merge-detector.ts:40-68] |

**Key insight:** This phase mostly wires existing primitives together in new ways. The codebase already has atomic writes, process killing, status reconciliation, and polling infrastructure. The new code is primarily coordination logic.

## Common Pitfalls

### Pitfall 1: Double Shutdown / Re-entrancy
**What goes wrong:** SIGINT arrives while graceful shutdown is already in progress, causing concurrent state writes or double lock release.
**Why it happens:** `process.once('SIGINT')` fires independently of any in-progress shutdown coordination.
**How to avoid:** Guard shutdown function with a `let shuttingDown = false` flag. Second signal either no-ops (graceful) or escalates to force.
**Warning signs:** "Lock file not found" errors during shutdown, corrupted status files.

### Pitfall 2: Orphaned Child Processes
**What goes wrong:** Orchestrator exits but spawned `claude` processes continue running, consuming resources and potentially committing to branches.
**Why it happens:** Child processes spawned with `spawn()` are not automatically killed when the parent exits. `process.on('exit')` handler cannot do async work.
**How to avoid:** For graceful shutdown, wait for current `processIssue` to complete (workers exit naturally). For force shutdown, call `killWorker()` for all active PIDs before exiting. Track active worker PIDs in a Set.
**Warning signs:** `claude` processes visible in `ps` after orchestrator exits.

### Pitfall 3: Shutdown File Persists After Crash
**What goes wrong:** Orchestrator crashes without cleaning up `.orchestrator/shutdown`. Next `orchestrator start` reads stale shutdown file and immediately shuts down.
**Why it happens:** Crash or SIGKILL doesn't run cleanup handlers.
**How to avoid:** `handleStart()` should always call `clearShutdownFile()` before starting orchestration. The shutdown file is transient IPC, not persistent state.
**Warning signs:** Orchestrator exits immediately after start with no work done.

### Pitfall 4: Promise.allSettled Groups During Force Shutdown
**What goes wrong:** `assignWork()` uses `Promise.allSettled()` to run multiple groups concurrently. Force shutdown needs to kill workers across ALL groups, not just the one that noticed the shutdown signal.
**Why it happens:** Each `processGroup` runs independently. If only one group checks `shouldShutdown()`, others continue.
**How to avoid:** Force shutdown should kill ALL tracked worker PIDs directly (not go through the scheduler). The shutdown coordinator maintains the active PID set and kills them all. The `Promise.allSettled` results will reflect the killed workers.
**Warning signs:** Some groups continue running during "force" shutdown.

### Pitfall 5: Resume Skips Reconciliation
**What goes wrong:** Status files say "coding" but the branch was force-pushed or rebased externally. Orchestrator tries to continue from a state that doesn't exist.
**Why it happens:** Status files are a cache of what the orchestrator THINKS happened. Git is the source of truth.
**How to avoid:** Always run `reconcile()` before resume. The existing `reconcile()` already resets status when branches are missing or have no commits. Extend it to also check for merged PRs.
**Warning signs:** Worktree creation fails on resume, or commits are applied to wrong base.

### Pitfall 6: Race Between Dashboard Write and Orchestrator Poll
**What goes wrong:** Dashboard writes "graceful", then user presses `q` again to upgrade to "force", but orchestrator already read "graceful" and is draining.
**Why it happens:** File-based IPC has inherent read-write race window.
**How to avoid:** Orchestrator should re-read the shutdown file periodically during drain (e.g., while waiting for current issue to finish). If mode changed to "force" during drain, escalate immediately.
**Warning signs:** Dashboard says "force killing" but orchestrator is still waiting for issue completion.

## Code Examples

### Shutdown-Aware processGroup Loop
```typescript
// Source: derived from scheduler.ts:248-254
async function processGroup(
  group: PRGroup,
  config: OrchestratorConfig,
  deps: SchedulerDeps,
  now: () => string,
): Promise<ProcessGroupResult> {
  // ... existing slug derivation and status init ...

  const status = deps.readGroupStatus(slug) ?? initGroupStatus(group, slug, now);
  const remaining = status.issues_remaining;

  for (const issueNumber of remaining) {
    // Shutdown check point — between issues only
    const shutdown = deps.shouldShutdown?.();
    if (shutdown) {
      safeWriteStatus(deps, slug, {
        ...freshStatus(slug, group, deps, now),
        current_issue: null,
        step: 'idle',
        step_result: 'interrupted',
        last_updated: now(),
      });
      return {
        completed: false,
        error: `shutdown requested (${shutdown.mode})`,
        shutdown: true,
      };
    }

    const result = await processIssue(group, issueNumber, slug, config, deps, now);
    if (!result.success) {
      return { completed: false, failedIssue: issueNumber, error: result.error };
    }
  }

  // ... existing self-review, PR creation, merge detection ...
}
```

### Enhanced Signal Handlers
```typescript
// Source: derived from lock.ts:79-90
export function installSignalHandlers(
  onShutdown: () => void,
  baseDir?: string,
): void {
  let shuttingDown = false;

  const signalHandler = () => {
    if (shuttingDown) return; // Prevent re-entrancy
    shuttingDown = true;
    onShutdown(); // Triggers graceful shutdown coordinator
  };

  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  process.once('exit', () => {
    releaseLock(baseDir);
  });
}
```

### Resume Detection in handleStart
```typescript
// Source: derived from cli.tsx:41-76
async function handleStart(args: readonly string[]): Promise<void> {
  // ... existing arg parsing ...

  // Always clear stale shutdown file
  clearShutdownFile();

  if (fresh) {
    clearRuntimeState();
  }

  acquireLock();

  // Detect resume: check for existing status files
  const hasExistingStatus = existsSync('.orchestrator/status') &&
    readdirSync('.orchestrator/status').some(f => f.endsWith('.json'));

  if (hasExistingStatus && !fresh) {
    process.stdout.write('Resuming from previous state...\n');
    // reconcile() + detectMergedPRs() before orchestrate()
  }

  // ... orchestrate with resume-aware overrides ...
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `process.exit(0)` in signal handlers | Graceful drain with state flush | This phase | Prevents orphaned workers, preserves resume state |
| Fresh `mergedPRs = new Set()` on start | Resume-aware merged PR detection | This phase | Enables resume without re-doing completed work |
| `q` = immediate dashboard exit | `q` = write shutdown file, monitor drain | This phase | Enables coordinated shutdown between dashboard and orchestrator |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Polling interval of 500ms-1000ms for shutdown file is sufficient responsiveness | Architecture Patterns | Low -- user would notice <1s delay at most; easily tunable |
| A2 | `process.once('exit')` handler runs synchronously before exit | Code Examples | Medium -- if async cleanup needed in exit handler, it won't complete. Mitigation: do all async cleanup before calling process.exit() |
| A3 | Dashboard and orchestrator always share the same `.orchestrator/` directory (same CWD) | Architecture Patterns | High -- if they don't, IPC fails entirely. Verified: both use `baseDir` parameter defaulting to `.` |

## Open Questions

1. **Worker PID Tracking for Force Shutdown**
   - What we know: `spawnClaudeProcess` returns a `WorkerHandle` with `pid`. The scheduler calls `processGroup` via `Promise.allSettled`, so multiple groups may have active workers simultaneously.
   - What's unclear: Where to maintain the active PID set. Options: (a) in the shutdown coordinator module, (b) as an addition to `SchedulerDeps`, (c) in `orchestrate.ts`.
   - Recommendation: Add an `ActiveWorkerRegistry` to the shutdown coordinator. The `spawnWorker`/`spawnDirectWorker` wrappers in `orchestrate.ts` register PIDs on spawn and deregister on exit. Force shutdown iterates the registry.

2. **Shutdown File Cleanup Responsibility**
   - What we know: Shutdown file should be cleaned up after orchestrator exits. Dashboard should NOT clean it (orchestrator may still be reading it).
   - What's unclear: Whether to clean in the `exit` handler or at the start of next run.
   - Recommendation: Clean at start of next run (`handleStart` always calls `clearShutdownFile`). The `exit` handler is unreliable for cleanup (SIGKILL, crashes).

3. **Resume: How to Detect Merged PRs Without Known PR Numbers**
   - What we know: Status files have `branch` but no `pr_number` field. The plan file has `pr_number` but plan PR numbers are placeholders (0 for unassigned).
   - What's unclear: How to map a resumed group to its actual GitHub PR number.
   - Recommendation: Use `gh pr list --head <branch> --json number,state` to find PRs by branch name. This is reliable and already how the merge-detector works conceptually.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | vitest.config.ts |
| Quick run command | `pnpm run test -- --run src/shutdown.test.ts` |
| Full suite command | `pnpm run test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SD-01 | Write/read/clear shutdown signal file | unit | `pnpm run test -- --run src/shutdown.test.ts` | No -- Wave 0 |
| SD-02 | Graceful shutdown: finish current issue, write interrupted, exit | unit | `pnpm run test -- --run src/scheduler.test.ts` | Exists (extend) |
| SD-03 | Force shutdown: SIGTERM all workers | unit | `pnpm run test -- --run src/shutdown.test.ts` | No -- Wave 0 |
| SD-04 | Double-q detection in TUI | unit | `pnpm run test -- --run src/tui/use-keyboard.test.ts` | No -- Wave 0 (need new test file) |
| SD-05 | Dashboard footer shows shutdown status | unit | `pnpm run test -- --run src/tui/Footer.test.ts` | No -- Wave 0 |
| SD-06 | Dashboard auto-exits when lock gone | unit | `pnpm run test -- --run src/tui/Dashboard.test.ts` | No -- Wave 0 |
| SD-07 | Resume detection + reconcile on start | unit | `pnpm run test -- --run src/resume.test.ts` | No -- Wave 0 |
| SD-08 | Signal handlers trigger shutdown coordinator | unit | `pnpm run test -- --run src/lock.test.ts` | Exists (extend) |
| SD-09 | Stale shutdown file cleared on start | unit | `pnpm run test -- --run src/cli.test.ts` | Exists (extend) |
| SD-10 | Merged PR detection via gh CLI | unit | `pnpm run test -- --run src/resume.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm run test -- --run src/shutdown.test.ts src/resume.test.ts src/scheduler.test.ts`
- **Per wave merge:** `pnpm run test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/shutdown.test.ts` -- covers SD-01, SD-03 (signal file CRUD, force kill coordination)
- [ ] `src/resume.test.ts` -- covers SD-07, SD-10 (resume detection, merged PR detection)
- [ ] `src/tui/use-keyboard.test.ts` -- covers SD-04 (double-q detection; file may need creating or extending)
- [ ] `src/tui/Footer.test.ts` -- covers SD-05 (conditional shutdown status rendering)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | N/A -- local CLI tool |
| V3 Session Management | No | N/A |
| V4 Access Control | No | Lock file already prevents concurrent access [VERIFIED: lock.ts] |
| V5 Input Validation | Yes | Validate shutdown file JSON schema before acting on it |
| V6 Cryptography | No | N/A |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious shutdown file injection | Tampering | Validate JSON schema strictly; shutdown file path is deterministic and local-only |
| Path traversal in baseDir | Tampering | Already mitigated by `path.resolve()` usage throughout codebase |
| Signal handler denial of service | Denial of Service | Re-entrancy guard prevents recursive shutdown attempts |

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/scheduler.ts`, `src/lock.ts`, `src/worker-manager.ts`, `src/status-manager.ts`, `src/merge-detector.ts`, `src/orchestrate.ts`, `src/cli.tsx`, `src/tui/use-keyboard.ts`, `src/tui/Dashboard.tsx`, `src/tui/launch.ts`, `src/types.ts`
- Context7 `/vadimdemedes/ink` -- useInput hook API, useApp exit pattern
- Node.js official docs -- fs.watch caveats, process signal handling

### Secondary (MEDIUM confidence)
- [Graceful Shutdown in Node.js (DEV Community)](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo) -- signal handling patterns
- [Node.js fs.watch documentation](https://nodejs.org/api/fs.html) -- caveats about platform-dependent behavior
- [Die, Child Process, Die! (Ex Ratione)](https://www.exratione.com/2013/05/die-child-process-die/) -- child process cleanup patterns

### Tertiary (LOW confidence)
- None -- all claims verified against codebase or official documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all patterns exist in codebase
- Architecture: HIGH -- straightforward file-based IPC with well-understood patterns
- Pitfalls: HIGH -- derived from direct codebase analysis of existing concurrency patterns
- Resume logic: MEDIUM -- resume decision tree is well-defined in CONTEXT.md but merged PR detection path needs implementation

**Research date:** 2026-05-03
**Valid until:** 2026-06-03 (stable domain, no external API changes expected)
