# Plan: CLI Subcommands with Lock File

## Summary
Implement three CLI subcommands (`init`, `start`, `status`) and a PID-based lock file manager for the claude-orchestrator. This replaces the current hello-world CLI with a proper subcommand router, config scaffolding, lock file lifecycle, and status reader.

## User Story
As a developer using claude-orchestrator, I want CLI subcommands to initialize config, start orchestration with safety guards, and check status, so that I can manage autonomous agent work safely without double-running.

## Problem -> Solution
Current CLI renders "hello world" with no subcommands -> CLI routes to `init`, `start <plan>`, and `status` with PID lock file preventing concurrent runs.

## Metadata
- **Complexity**: Medium
- **Source PRD**: docs/guide/claude-orchestrator-prd-v2.md
- **PRD Phase**: PR 1 / Issue #3
- **Estimated Files**: 10 (5 source + 5 test)

---

## UX Design

### Before
```
$ orchestrator
  orchestrator       # green bold text, nothing else
```

### After
```
$ orchestrator init
  Created .orchestrator/config.json with defaults.

$ orchestrator init          # already exists
  .orchestrator/config.json already exists. Overwrite? [y/N]

$ orchestrator start plan.md
  Acquired lock (.orchestrator/lock, PID 12345)
  # placeholder — actual scheduler is #9

$ orchestrator start plan.md  # while already running
  Error: Another orchestrator is running (PID 12345). Stop it first or remove .orchestrator/lock.

$ orchestrator start --fresh plan.md
  Cleared .orchestrator/status/, context/, logs/
  Acquired lock (.orchestrator/lock, PID 12345)

$ orchestrator status
  === Orchestrator Status ===
  pr-auth-module    in_progress  2/5 issues done
  pr-api-endpoints  queued       0/3 issues done

$ orchestrator status         # nothing running
  No active work.

$ orchestrator               # no subcommand
  Usage: orchestrator <command>
  Commands: init, start <plan>, status
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| No args | Green "orchestrator" text | Usage help | Print usage, exit 1 |
| `init` | N/A | Scaffold config | Interactive overwrite prompt |
| `start <plan>` | N/A | Acquire lock, placeholder start | Lock + signal handlers |
| `start --fresh` | N/A | Clear state dirs, then start | Removes status/context/logs |
| `status` | N/A | Print status summary | Read-only, no TUI |
| Ctrl+C during start | N/A | Clean lock file removal | SIGINT/SIGTERM handlers |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/cli.tsx` | all | Current entry point to replace |
| P0 | `package.json` | all | Dependencies, scripts, bin config |
| P0 | `docs/guide/claude-orchestrator-prd-v2.md` | 196-224 | Config shape definition |
| P1 | `docs/decisions/001-design-decisions.md` | 114-151 | CLI + .orchestrator/ structure decisions |
| P1 | `tsconfig.json` | all | Strict mode, module settings |
| P2 | `biome.json` | all | Formatting rules (tabs, single quotes) |
| P2 | `tsup.config.ts` | all | Build config, entry point |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Node process.kill(pid, 0) | Node.js docs | Check if PID is alive without sending signal; throws if dead |
| Node fs.rmSync | Node.js docs | `recursive: true, force: true` for dir cleanup |
| Node readline | Node.js docs | `createInterface` for simple Y/N prompt |

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/cli.tsx:1-14, package.json
- Files: kebab-case (`lock-manager.ts`, `config.ts`)
- Types: PascalCase (`OrchestratorConfig`, `LockInfo`)
- Functions: camelCase (`acquireLock`, `readStatus`)
- Binary: `orchestrator`

### ERROR_HANDLING
// SOURCE: user rules (typescript/coding-style.md)
```typescript
try {
	const result = await riskyOperation();
	return result;
} catch (error) {
	// User-friendly message to stderr, then exit
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}
```

### IMPORT_STYLE
// SOURCE: src/cli.tsx:2, biome.json
```typescript
import { Box, render, Text } from 'ink';  // alphabetical specifiers, single quotes, semicolons
```

### TEST_STRUCTURE
// SOURCE: src/cli.test.ts:1-7
```typescript
import { describe, expect, it } from 'vitest';

describe('module', () => {
	it('does thing', () => {
		expect(result).toBe(expected);
	});
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | CREATE | Config types, lock types, status types |
| `src/config.ts` | CREATE | Config creation, loading, validation |
| `src/lock.ts` | CREATE | Lock file acquire/release/check-stale |
| `src/status.ts` | CREATE | Read and format status files |
| `src/cli.tsx` | UPDATE | Subcommand router replacing hello-world |
| `src/types.test.ts` | CREATE | Config type/validation tests |
| `src/config.test.ts` | CREATE | Config init/load tests |
| `src/lock.test.ts` | CREATE | Lock lifecycle tests |
| `src/status.test.ts` | CREATE | Status reading tests |
| `src/cli.test.ts` | UPDATE | CLI routing integration tests |

## NOT Building
- Actual scheduler logic (Issue #9)
- PR plan parsing (Issue #4)
- TUI dashboard rendering (Issue #11)
- Status file writing (Issue #5)
- Ink components — all output via `process.stdout.write` / `process.stderr.write` for now

---

## Step-by-Step Tasks

### Task 1: Define types
- **ACTION**: Create `src/types.ts` with all type definitions
- **IMPLEMENT**:
  ```typescript
  export interface VerifyCommand {
  	readonly name: string;
  	readonly command: string;
  }

  export interface IssueSource {
  	readonly type: string;
  	readonly repo: string;
  }

  export interface NotificationConfig {
  	readonly system: boolean;
  }

  export interface OrchestratorConfig {
  	readonly base_branch: string;
  	readonly max_concurrent_agents: number;
  	readonly max_retries_on_fail: number;
  	readonly max_review_cycles: number;
  	readonly verify: readonly VerifyCommand[];
  	readonly rule_files: readonly string[];
  	readonly issue_source: IssueSource;
  	readonly notifications: NotificationConfig;
  }

  export interface StatusEntry {
  	readonly slug: string;
  	readonly state: string;
  	readonly issues_total: number;
  	readonly issues_done: number;
  }
  ```
- **MIRROR**: NAMING_CONVENTION (PascalCase types, readonly for immutability)
- **IMPORTS**: None (pure types)
- **GOTCHA**: Use `readonly` on all fields and `readonly` arrays per immutability rules. Use snake_case for config fields to match JSON shape from PRD.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Implement config module
- **ACTION**: Create `src/config.ts` with default config creation and loading
- **IMPLEMENT**:
  - `DEFAULT_CONFIG: OrchestratorConfig` constant matching PRD shape exactly
  - `getConfigPath(): string` — returns `path.resolve('.orchestrator/config.json')`
  - `configExists(): boolean` — checks if config file exists
  - `writeDefaultConfig(force: boolean): void` — writes default config, checks existence
  - `loadConfig(): OrchestratorConfig` — reads and parses config file
  - `promptOverwrite(): Promise<boolean>` — readline Y/N prompt
- **MIRROR**: ERROR_HANDLING, IMPORT_STYLE
- **IMPORTS**: `node:fs`, `node:path`, `node:readline`
- **GOTCHA**: Use `node:` prefix for Node built-ins (ESM convention). Config JSON uses snake_case field names (matches PRD). `mkdirSync` the `.orchestrator/` dir if it doesn't exist before writing.
- **VALIDATE**: `pnpm run typecheck`, unit tests pass

### Task 3: Implement lock module
- **ACTION**: Create `src/lock.ts` with PID lock file lifecycle
- **IMPLEMENT**:
  - `LOCK_PATH` constant: `path.resolve('.orchestrator/lock')`
  - `isProcessAlive(pid: number): boolean` — `process.kill(pid, 0)` in try/catch
  - `readLock(): number | null` — read PID from lock file, return null if missing
  - `isLockStale(): boolean` — lock exists but PID is dead
  - `acquireLock(): void` — write current PID, fail if active lock exists, clean if stale
  - `releaseLock(): void` — remove lock file if it contains our PID
  - `installSignalHandlers(): void` — SIGINT/SIGTERM handlers that call `releaseLock()`
- **MIRROR**: ERROR_HANDLING
- **IMPORTS**: `node:fs`, `node:path`, `node:process`
- **GOTCHA**: `process.kill(pid, 0)` throws `ESRCH` if process doesn't exist — catch that specific error. On Windows, `process.kill(pid, 0)` behavior differs but Node abstracts it. Always check our own PID before deleting lock (don't delete another instance's lock). Write PID as plain text with newline.
- **VALIDATE**: `pnpm run typecheck`, unit tests pass

### Task 4: Implement status module
- **ACTION**: Create `src/status.ts` to read and display status files
- **IMPLEMENT**:
  - `STATUS_DIR` constant: `path.resolve('.orchestrator/status')`
  - `readStatusFiles(): StatusEntry[]` — glob `*.json` in status dir, parse each
  - `formatStatus(entries: StatusEntry[]): string` — format for console output
  - `printStatus(): void` — orchestrates read + format + print, handles "No active work"
- **MIRROR**: ERROR_HANDLING, NAMING_CONVENTION
- **IMPORTS**: `node:fs`, `node:path`, `./types.ts`
- **GOTCHA**: Status dir may not exist yet (no error, just "No active work"). JSON parse errors should warn and skip that file, not crash. Status file shape is defined by Issue #5 (Status Manager) — for now, read whatever JSON is there and display slug + state + progress.
- **VALIDATE**: `pnpm run typecheck`, unit tests pass

### Task 5: Implement fresh-start cleanup
- **ACTION**: Add `clearRuntimeState()` to a new `src/runtime.ts` or inline in CLI
- **IMPLEMENT**:
  - `clearRuntimeState(): void` — removes `.orchestrator/status/`, `.orchestrator/context/`, `.orchestrator/logs/` directories recursively
  - Use `fs.rmSync(dir, { recursive: true, force: true })` — `force: true` means no error if missing
- **MIRROR**: ERROR_HANDLING
- **IMPORTS**: `node:fs`, `node:path`
- **GOTCHA**: Only clears runtime dirs, never touches `config.json` or `lock`.
- **VALIDATE**: `pnpm run typecheck`, unit tests pass

### Task 6: Rewrite CLI entry point with subcommand routing
- **ACTION**: Replace `src/cli.tsx` hello-world with subcommand parser
- **IMPLEMENT**:
  - Parse `process.argv.slice(2)` for subcommand
  - Route: `init` -> config init flow, `start` -> lock + placeholder, `status` -> print status
  - Handle `--fresh` flag on `start`
  - Print usage on no/unknown subcommand, exit 1
  - `start` flow: validate plan file exists -> acquire lock -> install signal handlers -> placeholder message
  - No Ink rendering needed yet — pure `process.stdout.write`
- **MIRROR**: ERROR_HANDLING, IMPORT_STYLE
- **IMPORTS**: `./config.ts`, `./lock.ts`, `./status.ts`
- **GOTCHA**: Keep hashbang `#!/usr/bin/env node` on line 1. Can rename to `cli.ts` (drop `.tsx`) since no JSX needed anymore — but check if tsup config needs updating. Actually, keep as `.tsx` for now to avoid build config changes; TSX files without JSX are valid.
- **VALIDATE**: `pnpm run build` succeeds, `node dist/cli.js init` works

### Task 7: Write unit tests for config module
- **ACTION**: Create `src/config.test.ts`
- **IMPLEMENT**:
  - Test default config shape matches PRD
  - Test `writeDefaultConfig` creates file with correct content
  - Test `writeDefaultConfig` fails gracefully when config exists (without force)
  - Test `writeDefaultConfig` overwrites when force=true
  - Test `loadConfig` reads and parses correctly
  - Test `configExists` returns correct boolean
  - Use temp directories for file operations (vitest `beforeEach`/`afterEach` with `fs.mkdtempSync`)
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, `node:fs`, `node:path`, `node:os`, `./config.ts`
- **GOTCHA**: Tests must not write to actual `.orchestrator/` — use temp dirs. Clean up temp dirs in `afterEach`.
- **VALIDATE**: `pnpm run test` passes

### Task 8: Write unit tests for lock module
- **ACTION**: Create `src/lock.test.ts`
- **IMPLEMENT**:
  - Test `acquireLock` creates lock file with current PID
  - Test `acquireLock` throws when active lock exists
  - Test `acquireLock` cleans stale lock (dead PID) and acquires
  - Test `releaseLock` removes lock file
  - Test `releaseLock` no-ops if lock file doesn't exist
  - Test `isProcessAlive` returns true for current PID, false for dead PID
  - Test `readLock` returns null when no lock
  - Use temp directories, mock `process.pid` where needed
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, `node:fs`, `node:path`, `node:os`, `./lock.ts`
- **GOTCHA**: Finding a guaranteed-dead PID for testing — use a very high number like 999999. Signal handler tests are tricky; test the functions they call, not the signal registration itself.
- **VALIDATE**: `pnpm run test` passes

### Task 9: Write unit tests for status module
- **ACTION**: Create `src/status.test.ts`
- **IMPLEMENT**:
  - Test `readStatusFiles` returns empty array when dir doesn't exist
  - Test `readStatusFiles` parses valid JSON files
  - Test `readStatusFiles` skips invalid JSON gracefully
  - Test `formatStatus` with entries produces expected output
  - Test `formatStatus` with empty array produces "No active work"
  - Use temp directories with sample JSON files
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, `node:fs`, `node:path`, `node:os`, `./status.ts`
- **GOTCHA**: Create realistic status JSON fixtures matching expected shape.
- **VALIDATE**: `pnpm run test` passes

### Task 10: Write CLI integration tests
- **ACTION**: Update `src/cli.test.ts` with subcommand routing tests
- **IMPLEMENT**:
  - Test unknown subcommand prints usage
  - Test `init` creates config in temp dir
  - Test `start` with missing plan file fails
  - Test `start` with valid plan file acquires lock
  - Test `status` with no status files prints "No active work"
  - May need to extract CLI logic into testable functions rather than testing process execution
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, relevant modules
- **GOTCHA**: CLI tests that spawn processes are slow and flaky. Prefer testing the routing logic as functions. If spawning, use `node dist/cli.js` (requires build first).
- **VALIDATE**: `pnpm run test` passes, all tests green

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Default config matches PRD | none | Config with all PRD fields | No |
| Write config when none exists | empty dir | config.json created | No |
| Write config when exists, no force | existing config | Error/skip | Yes |
| Write config with force | existing config | Config overwritten | No |
| Load valid config | valid JSON file | Parsed config object | No |
| Acquire lock, no existing | empty dir | Lock file with PID | No |
| Acquire lock, active lock | lock with live PID | Error thrown | Yes |
| Acquire lock, stale lock | lock with dead PID | Stale cleaned, new lock | Yes |
| Release lock | lock file exists | Lock file removed | No |
| Release lock, no file | no lock file | No error | Yes |
| Is process alive, self | current PID | true | No |
| Is process alive, dead | 999999 | false | Yes |
| Read status, no dir | missing dir | Empty array | Yes |
| Read status, valid files | JSON files | Parsed entries | No |
| Read status, invalid JSON | Bad file | Skipped, no crash | Yes |
| Format status, entries | StatusEntry[] | Formatted string | No |
| Format status, empty | [] | "No active work" | Yes |

### Edge Cases Checklist
- [x] Empty input (no subcommand -> usage)
- [x] Invalid subcommand (-> usage)
- [x] Config already exists (-> prompt or skip)
- [x] Plan file doesn't exist (-> clear error)
- [x] Lock file with dead PID (-> clean and proceed)
- [x] Lock file with live PID (-> error)
- [x] No status directory (-> "No active work")
- [x] Malformed status JSON (-> skip gracefully)
- [x] SIGINT during start (-> release lock)
- [x] SIGTERM during start (-> release lock)

---

## Validation Commands

### Static Analysis
```bash
pnpm run check
```
EXPECT: Zero lint/format errors

### Type Check
```bash
pnpm run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm run test
```
EXPECT: All tests pass, 80%+ coverage on new files

### Build
```bash
pnpm run build
```
EXPECT: `dist/cli.js` generated, no errors

### Manual Validation
- [ ] `node dist/cli.js` prints usage
- [ ] `node dist/cli.js init` creates `.orchestrator/config.json` (run in temp dir)
- [ ] `node dist/cli.js init` again prompts about existing config
- [ ] `node dist/cli.js start nonexistent.md` fails with clear error
- [ ] `node dist/cli.js start plan.md` (with dummy file) acquires lock
- [ ] Second `node dist/cli.js start plan.md` fails with PID error
- [ ] `node dist/cli.js status` prints "No active work"
- [ ] Ctrl+C during start removes lock file

---

## Acceptance Criteria
- [ ] `orchestrator init` creates `.orchestrator/config.json` with default config shape
- [ ] `orchestrator init` fails gracefully if config already exists (asks to overwrite or skips)
- [ ] `orchestrator start <plan.md>` validates plan file exists, acquires lock with current PID
- [ ] `orchestrator start` fails with clear error if lock exists and process still running
- [ ] `orchestrator start` cleans stale lock if referenced PID is dead
- [ ] `orchestrator start --fresh` clears `.orchestrator/status/`, `.orchestrator/context/`, `.orchestrator/logs/`
- [ ] `orchestrator status` reads `.orchestrator/status/*.json` and prints summary
- [ ] `orchestrator status` prints "No active work" if no status files exist
- [ ] Lock file released on process exit (normal and SIGINT/SIGTERM)

## Completion Checklist
- [ ] Code follows discovered patterns (naming, imports, error handling)
- [ ] Error handling uses stderr + exit code pattern
- [ ] All config fields match PRD v2 exactly (snake_case JSON keys)
- [ ] Tests follow vitest globals + colocated pattern
- [ ] No hardcoded values (paths computed from CWD)
- [ ] Immutability enforced (readonly types, no mutation)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lock file race condition (two processes check simultaneously) | Low | Medium | Acceptable for CLI tool; atomic write not needed for single-user |
| Status JSON shape undefined | Medium | Low | Read whatever fields exist, display generically until #5 defines shape |
| Config shape drift from PRD | Low | High | Types mirror PRD v2 exactly; any PRD change requires type update |

## Notes
- No new npm dependencies needed. All functionality uses Node built-ins (`node:fs`, `node:path`, `node:readline`, `node:process`).
- Ink dependency stays in package.json but is unused in this PR. Future issues (#11 TUI) will use it.
- The `start` command acquires lock and prints a placeholder message. Actual orchestration logic comes from Issue #9 (Scheduler).
- File can stay as `.tsx` even without JSX to avoid tsup config changes.
