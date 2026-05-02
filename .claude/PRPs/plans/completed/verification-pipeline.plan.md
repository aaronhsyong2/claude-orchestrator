# Plan: Verification Pipeline

## Summary
Implement a Verification Pipeline module that executes project-defined verification commands serially with fail-fast behavior. Each command runs via `exec` with shell support, captures stdout/stderr, tracks duration, and stops on first non-zero exit code. Returns a structured `VerifyResult` with per-step details.

## User Story
As the orchestrator scheduler, I want to run verification commands (lint, typecheck, build, test) in agent worktrees, so that I can validate agent output before proceeding.

## Problem → Solution
No verification pipeline exists — no way to validate agent output → A module executes commands serially with fail-fast, returning structured results per step.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A (issue #8 from PR plan)
- **Estimated Files**: 3 (types update, verification.ts, verification.test.ts)

---

## UX Design

N/A — internal module, no user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `src/types.ts` | 1-4 | VerifyCommand already exists — add result types nearby |
| P0 (critical) | `src/config.ts` | 11-17 | Default verify commands — this is what the pipeline executes |
| P1 (important) | `src/worktree-manager.ts` | 22-29 | getGitErrorMessage pattern for extracting exec errors |
| P2 (reference) | `src/worktree-manager.test.ts` | 16-21 | vi.mock pattern for child_process |

## External Documentation

No external research needed — uses Node.js built-in `child_process.exec` with well-understood patterns.

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/worktree-manager.ts:1-7
// Files: kebab-case (verification.ts)
// Functions: camelCase (verify, runStep)
// Types: PascalCase (VerifyResult, StepResult)
```

### ERROR_HANDLING
```typescript
// SOURCE: src/worktree-manager.ts:22-29
// Extract error info from child_process errors
function getGitErrorMessage(err: unknown): string {
	if (err && typeof err === 'object' && 'stderr' in err) {
		const stderr = (err as { stderr: Buffer | string }).stderr;
		const text = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr);
		if (text.trim()) return text.trim();
	}
	return err instanceof Error ? err.message : String(err);
}
```

### IMMUTABILITY
```typescript
// SOURCE: src/types.ts:1-4
// All interfaces use readonly fields
export interface VerifyCommand {
	readonly name: string;
	readonly command: string;
}
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/worktree-manager.test.ts:16-32
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, execFileSync: vi.fn() };
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add StepResult and VerifyResult interfaces |
| `src/verification.ts` | CREATE | Core verification pipeline module |
| `src/verification.test.ts` | CREATE | Tests with mocked exec |

## NOT Building

- Retry logic on failure (that's #15)
- Deciding when to run verification (that's Scheduler #9)
- Fix commands or auto-remediation
- Integration with CLI or TUI

---

## Step-by-Step Tasks

### Task 1: Add StepResult and VerifyResult types to types.ts
- **ACTION**: Add result interfaces after VerifyCommand
- **IMPLEMENT**:
  ```typescript
  export interface StepResult {
  	readonly name: string;
  	readonly command: string;
  	readonly exitCode: number;
  	readonly duration: number;
  	readonly stdout: string;
  	readonly stderr: string;
  }

  export interface VerifyResult {
  	readonly success: boolean;
  	readonly failedStep?: string;
  	readonly error?: string;
  	readonly steps: readonly StepResult[];
  }
  ```
- **MIRROR**: IMMUTABILITY — readonly fields, PascalCase names
- **IMPORTS**: None
- **GOTCHA**: Place after VerifyCommand (line 4) to keep related types together
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create verification.ts with verify function
- **ACTION**: Create the core module with `verify` function
- **IMPLEMENT**:
  ```typescript
  import { exec } from 'node:child_process';
  import type { StepResult, VerifyCommand, VerifyResult } from './types.js';

  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  export async function verify(
  	cwd: string,
  	commands: readonly VerifyCommand[],
  	timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<VerifyResult> {
  	const steps: StepResult[] = [];

  	for (const cmd of commands) {
  		const result = await runStep(cmd, cwd, timeoutMs);
  		steps.push(result);

  		if (result.exitCode !== 0) {
  			return {
  				success: false,
  				failedStep: cmd.name,
  				error: result.stderr || result.stdout,
  				steps,
  			};
  		}
  	}

  	return { success: true, steps };
  }
  ```
- **MIRROR**: NAMING_CONVENTION, IMMUTABILITY
- **IMPORTS**: `node:child_process`
- **GOTCHA**: Must use `exec` (not `execFile`) for shell support — commands like `pnpm run test -- --run` need shell interpretation
- **VALIDATE**: Typecheck passes

### Task 3: Implement runStep helper
- **ACTION**: Add private `runStep` function that executes a single command
- **IMPLEMENT**:
  ```typescript
  function runStep(
  	cmd: VerifyCommand,
  	cwd: string,
  	timeoutMs: number,
  ): Promise<StepResult> {
  	return new Promise((resolve) => {
  		const start = Date.now();

  		exec(cmd.command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
  			const duration = Date.now() - start;
  			const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  				? 1
  				: (error as { status?: number }).status ?? 1
  				: 0;

  			resolve({
  				name: cmd.name,
  				command: cmd.command,
  				exitCode: typeof exitCode === 'number' ? exitCode : 1,
  				duration,
  				stdout: stdout ?? '',
  				stderr: stderr ?? '',
  			});
  		});
  	});
  }
  ```
- **MIRROR**: ERROR_HANDLING — graceful handling of exec errors
- **IMPORTS**: Already imported exec
- **GOTCHA**: `exec` callback `error` has different shapes: `error.code` can be a string (like 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') or `error.status` holds the exit code. For command-not-found (ENOENT), `error.code` is 'ENOENT'. Always resolve (never reject) — errors are captured in the step result.
- **VALIDATE**: Test with mock exec

### Task 4: Write tests for verification pipeline
- **ACTION**: Create `src/verification.test.ts` with comprehensive tests
- **IMPLEMENT**: Tests covering:
  1. All commands pass — returns `{ success: true, steps: [...] }`
  2. Fail-fast on first failure — returns failure result, stops executing
  3. Each step has name, command, exitCode, duration, stdout, stderr
  4. Empty commands array — returns `{ success: true, steps: [] }`
  5. Command not found — returns failure with ENOENT-like error
  6. Command timeout — returns failure with timeout error
  7. Multiple commands — verifies serial execution order
  8. Captures stdout and stderr separately
  
  Mock `exec` via `vi.mock('node:child_process')` — the mock `exec` should accept a callback and invoke it with controlled stdout/stderr/error.
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, `node:child_process`
- **GOTCHA**: `exec` has a different signature than `execFile`/`spawn` — it takes `(command, options, callback)`. The mock needs to handle this callback pattern. Use `vi.fn()` and invoke the callback manually in tests.
- **VALIDATE**: `pnpm run test` — all tests pass

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| all pass | 3 commands, all exit 0 | `{ success: true, steps: [3] }` | No |
| fail-fast | 3 commands, 2nd fails | `{ success: false, failedStep, steps: [2] }` | No |
| step details | 1 command | step has name, command, exitCode, duration, stdout, stderr | No |
| empty commands | [] | `{ success: true, steps: [] }` | Yes |
| command not found | invalid command | `{ success: false, error }` | Yes |
| command timeout | slow command | `{ success: false, failedStep }` | Yes |
| serial order | 3 commands | executed in order | No |
| stdout/stderr capture | command with both | stdout and stderr captured separately | No |

### Edge Cases Checklist
- [x] Empty commands array
- [x] Command not found
- [x] Command timeout
- [x] First command fails
- [x] Last command fails
- [x] Large stdout/stderr output

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
pnpm run test -- --run
```
EXPECT: All tests pass

### Build
```bash
pnpm run build
```
EXPECT: Clean build

---

## Acceptance Criteria
- [x] `verify(cwd, commands)` executes each command serially
- [x] Stops immediately on first non-zero exit code
- [x] Returns success result with all step details
- [x] Returns failure result with failed step name and error
- [x] Each step includes: name, command, exit code, duration, stdout, stderr
- [x] Commands executed with shell (supports `pnpm run ...`)
- [x] Handles command timeout (configurable, default 5 minutes)
- [x] Handles command not found with clear error
- [x] Tests mock command execution and verify ordering and fail-fast

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Tests follow test patterns
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| exec callback error shape varies | Medium | Low | Handle both `error.status` and `error.code` patterns, always resolve |
| Mock exec complexity | Low | Low | exec callback is simpler than spawn stream mocking |

## Notes
- This module is intentionally simple — a serial loop with fail-fast. No parallelism, no retry, no streaming.
- `exec` is used instead of `execFile` because commands need shell interpretation (e.g., `pnpm run test -- --run` with pipes).
- The function always resolves (never rejects). All errors are captured in the `StepResult` structure. This makes the caller's code simpler — no try/catch needed.
- Duration is wall-clock time in milliseconds, measured with `Date.now()`.
- Timeout is passed directly to `exec`'s `timeout` option, which sends SIGTERM to the child process.
