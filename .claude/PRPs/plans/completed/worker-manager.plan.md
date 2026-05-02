# Plan: Worker Manager

## Summary
Implement a Worker Manager module that spawns `claude -p --output-format stream-json` subprocesses in worktree directories, parses NDJSON output streams into typed messages, captures raw output to log files, and provides lifecycle management with graceful shutdown (SIGTERM → SIGKILL). Uses Node.js built-in EventEmitter for event dispatch and readline for line-by-line NDJSON parsing.

## User Story
As the orchestrator scheduler, I want to spawn Claude agent workers in isolated worktrees and receive structured events about their progress, so that I can track, display, and react to agent activity.

## Problem → Solution
No subprocess management exists — the orchestrator cannot run Claude agents → A module wraps `claude -p` spawning with NDJSON stream parsing, lifecycle events, log capture, and graceful kill.

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: N/A (issue #7 from PR plan)
- **Estimated Files**: 3 (types update, worker-manager.ts, worker-manager.test.ts)

---

## UX Design

N/A — internal module, no user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `src/worktree-manager.ts` | 1-162 | Closest analog — child_process usage, error extraction, baseDir pattern |
| P0 (critical) | `src/types.ts` | 1-96 | All existing types — add new types here |
| P0 (critical) | `src/status-manager.ts` | 83-117 | Context file CRUD — readContext/writeContext integration |
| P1 (important) | `src/worktree-manager.test.ts` | 16-21 | vi.mock pattern for child_process |
| P1 (important) | `src/runtime.ts` | 1-12 | Logs directory already reserved in RUNTIME_DIRS |
| P2 (reference) | `src/config.ts` | 6-26 | Default config fields available |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `claude -p` stream-json | Claude Code CLI | `--output-format stream-json` outputs NDJSON lines with `type` field: `system`, `assistant`, `result` |
| Node.js readline | nodejs.org | `readline.createInterface({ input: stream })` for line-by-line parsing |
| Node.js spawn | nodejs.org | `spawn(cmd, args, opts)` returns ChildProcess with stdout/stderr streams |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/worktree-manager.ts:1-7
// Files: kebab-case (worker-manager.ts)
// Functions: camelCase with verb prefixes (spawn*, kill*, parse*)
// Types: PascalCase (WorkerHandle, NdjsonMessage)
// Constants: UPPER_SNAKE for config values
```

### ERROR_HANDLING
```typescript
// SOURCE: src/worktree-manager.ts:22-29
function getGitErrorMessage(err: unknown): string {
	if (err && typeof err === 'object' && 'stderr' in err) {
		const stderr = (err as { stderr: Buffer | string }).stderr;
		const text = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr);
		if (text.trim()) return text.trim();
	}
	return err instanceof Error ? err.message : String(err);
}
```

### BASEDIR_PATTERN
```typescript
// SOURCE: src/status-manager.ts:22-24
export function getGroupStatusPath(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/status', `${groupSlug}.json`);
}
```

### IMMUTABILITY
```typescript
// SOURCE: src/parser.ts:111
// Always readonly types, spread for updates
currentGroup = { ...currentGroup, branch: branchMatch[1] };
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/worktree-manager.test.ts:16-32
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, execFileSync: vi.fn() };
});

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wm-'));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});
```

### CONTEXT_FILE_PATTERN
```typescript
// SOURCE: src/status-manager.ts:83-93
export function writeContext(
	groupSlug: string,
	issue: string,
	content: string,
	baseDir?: string,
): void {
	assertValidSlug(groupSlug);
	const contextDir = getContextDir(groupSlug, baseDir);
	fs.mkdirSync(contextDir, { recursive: true });
	fs.writeFileSync(path.join(contextDir, `${issue}.md`), content);
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add NdjsonMessage union, WorkerHandle, WorkerEvent types |
| `src/worker-manager.ts` | CREATE | Core worker spawning, NDJSON parsing, lifecycle management |
| `src/worker-manager.test.ts` | CREATE | Tests with mock subprocess |

## NOT Building

- Deciding when to spawn workers (that's Scheduler #9)
- Retry logic (that's #15)
- Review-specific prompts (that's #16, #17)
- Integration with CLI or TUI
- Worker pool management or concurrency control

---

## Step-by-Step Tasks

### Task 1: Add NDJSON and Worker types to types.ts
- **ACTION**: Add message types, worker handle interface, and worker event types
- **IMPLEMENT**:
  ```typescript
  // NDJSON message types from claude -p --output-format stream-json
  export interface NdjsonSystemMessage {
  	readonly type: 'system';
  	readonly subtype: 'init';
  	readonly session_id: string;
  }

  export interface NdjsonAssistantMessage {
  	readonly type: 'assistant';
  	readonly message: string;
  }

  export interface NdjsonResultMessage {
  	readonly type: 'result';
  	readonly result: string;
  	readonly is_error: boolean;
  }

  export type NdjsonMessage = NdjsonSystemMessage | NdjsonAssistantMessage | NdjsonResultMessage;

  export type WorkerEventType = 'spawned' | 'message' | 'error' | 'exited';

  export interface WorkerHandle {
  	readonly id: string;
  	readonly issue: string;
  	readonly groupSlug: string;
  	readonly pid: number;
  }
  ```
- **MIRROR**: NAMING_CONVENTION, IMMUTABILITY — PascalCase, readonly fields
- **IMPORTS**: None — types.ts has no imports
- **GOTCHA**: Keep readonly throughout. Use discriminated union on `type` field for NdjsonMessage.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create worker-manager.ts with prompt builder
- **ACTION**: Create module with `buildPrompt` function
- **IMPLEMENT**:
  ```typescript
  export function buildPrompt(issueNumber: string, contextContent?: string): string {
  	const base = `/pick-up #${issueNumber}`;
  	if (!contextContent) return base;
  	return `${base}\n\nContext from previous attempt:\n${contextContent}`;
  }
  ```
- **MIRROR**: NAMING_CONVENTION
- **IMPORTS**: None for this function
- **GOTCHA**: Issue number may be a string like "10" — prepend `#` for the `/pick-up` command
- **VALIDATE**: Unit test for prompt construction

### Task 3: Implement getLogPath and log directory helpers
- **ACTION**: Add `getLogDir` and `getLogPath` functions following baseDir pattern
- **IMPLEMENT**:
  ```typescript
  export function getLogDir(groupSlug: string, baseDir?: string): string {
  	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug);
  }

  export function getLogPath(groupSlug: string, issue: string, baseDir?: string): string {
  	return path.join(getLogDir(groupSlug, baseDir), `${issue}.log`);
  }
  ```
- **MIRROR**: BASEDIR_PATTERN
- **IMPORTS**: `node:path`
- **GOTCHA**: Matches `.orchestrator/logs/` directory reserved by runtime.ts
- **VALIDATE**: Unit test verifying path derivation

### Task 4: Implement parseNdjsonLine
- **ACTION**: Add function to parse a single NDJSON line into typed message
- **IMPLEMENT**:
  ```typescript
  export function parseNdjsonLine(line: string): NdjsonMessage | null {
  	const trimmed = line.trim();
  	if (!trimmed) return null;

  	let parsed: unknown;
  	try {
  		parsed = JSON.parse(trimmed);
  	} catch {
  		return null;
  	}

  	if (typeof parsed !== 'object' || parsed === null) return null;
  	const obj = parsed as Record<string, unknown>;

  	if (typeof obj.type !== 'string') return null;

  	switch (obj.type) {
  		case 'system':
  			return { type: 'system', subtype: String(obj.subtype ?? ''), session_id: String(obj.session_id ?? '') } as NdjsonSystemMessage;
  		case 'assistant':
  			return { type: 'assistant', message: String(obj.message ?? '') } as NdjsonAssistantMessage;
  		case 'result':
  			return { type: 'result', result: String(obj.result ?? ''), is_error: Boolean(obj.is_error) } as NdjsonResultMessage;
  		default:
  			return null;
  	}
  }
  ```
- **MIRROR**: ERROR_HANDLING — graceful null return on invalid data
- **IMPORTS**: None
- **GOTCHA**: Must handle malformed JSON, unknown types, and missing fields gracefully. Return null for unrecognized messages (forward-compatible).
- **VALIDATE**: Unit tests with valid and invalid NDJSON lines

### Task 5: Implement spawnWorker
- **ACTION**: Create the core spawn function that starts `claude -p` and sets up NDJSON parsing
- **IMPLEMENT**:
  ```typescript
  import { spawn, type ChildProcess } from 'node:child_process';
  import * as readline from 'node:readline';

  export type WorkerEventCallback = (event: WorkerEventType, data: NdjsonMessage | number | Error) => void;

  export function spawnWorker(
  	issue: string,
  	groupSlug: string,
  	worktreePath: string,
  	onEvent: WorkerEventCallback,
  	contextContent?: string,
  	baseDir?: string,
  ): WorkerHandle {
  	const prompt = buildPrompt(issue, contextContent);
  	const logPath = getLogPath(groupSlug, issue, baseDir);
  	fs.mkdirSync(path.dirname(logPath), { recursive: true });
  	const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  	let proc: ChildProcess;
  	try {
  		proc = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
  			cwd: worktreePath,
  			stdio: ['ignore', 'pipe', 'pipe'],
  			env: { ...process.env, ECC_HOOK_PROFILE: 'minimal', ECC_GATEGUARD: 'off' },
  		});
  	} catch (err: unknown) {
  		const message = err instanceof Error ? err.message : String(err);
  		throw new Error(`Failed to spawn claude: ${message}`);
  	}

  	if (!proc.pid) {
  		throw new Error('Failed to spawn claude — process has no PID');
  	}

  	const handle: WorkerHandle = {
  		id: `${groupSlug}-${issue}`,
  		issue,
  		groupSlug,
  		pid: proc.pid,
  	};

  	// Parse NDJSON from stdout
  	if (proc.stdout) {
  		const rl = readline.createInterface({ input: proc.stdout });
  		rl.on('line', (line) => {
  			logStream.write(`${line}\n`);
  			const msg = parseNdjsonLine(line);
  			if (msg) {
  				onEvent('message', msg);
  			}
  		});
  	}

  	// Capture stderr
  	let stderrChunks: Buffer[] = [];
  	if (proc.stderr) {
  		proc.stderr.on('data', (chunk: Buffer) => {
  			stderrChunks.push(chunk);
  		});
  	}

  	// Handle spawn error (e.g., claude not in PATH)
  	proc.on('error', (err) => {
  		logStream.end();
  		onEvent('error', err);
  	});

  	// Handle exit
  	proc.on('close', (code) => {
  		logStream.end();
  		onEvent('exited', code ?? 1);
  	});

  	onEvent('spawned', 0);
  	return handle;
  }
  ```
- **MIRROR**: ERROR_HANDLING, BASEDIR_PATTERN
- **IMPORTS**: `node:child_process` (spawn), `node:readline`, `node:fs`, `node:path`
- **GOTCHA**: `spawn` is async — errors like ENOENT (claude not found) come via the `'error'` event, not synchronous throw. Must handle both sync spawn failure and async error event. Use `'close'` not `'exit'` to ensure streams are flushed before processing exit code.
- **VALIDATE**: Test with mock subprocess verifying event sequence

### Task 6: Implement killWorker
- **ACTION**: Add graceful kill function (SIGTERM → wait → SIGKILL)
- **IMPLEMENT**:
  ```typescript
  const KILL_TIMEOUT_MS = 5000;

  export async function killWorker(pid: number): Promise<void> {
  	try {
  		process.kill(pid, 0); // Check if alive
  	} catch {
  		return; // Already dead
  	}

  	process.kill(pid, 'SIGTERM');

  	const died = await waitForExit(pid, KILL_TIMEOUT_MS);
  	if (!died) {
  		try {
  			process.kill(pid, 'SIGKILL');
  		} catch {
  			// Already dead between SIGTERM and SIGKILL
  		}
  	}
  }

  function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  	return new Promise((resolve) => {
  		const start = Date.now();
  		const check = () => {
  			try {
  				process.kill(pid, 0);
  			} catch {
  				resolve(true);
  				return;
  			}
  			if (Date.now() - start >= timeoutMs) {
  				resolve(false);
  				return;
  			}
  			setTimeout(check, 100);
  		};
  		check();
  	});
  }
  ```
- **MIRROR**: ERROR_HANDLING — from lock.ts process.kill pattern
- **IMPORTS**: None beyond what's already imported
- **GOTCHA**: `process.kill(pid, 0)` throws if process doesn't exist (ESRCH). Use this to check if alive. Must handle race where process dies between SIGTERM and SIGKILL.
- **VALIDATE**: Test with mock PID

### Task 7: Write tests for worker-manager
- **ACTION**: Create `src/worker-manager.test.ts` with comprehensive tests
- **IMPLEMENT**: Tests covering:
  1. `buildPrompt` — with and without context
  2. `getLogDir` / `getLogPath` — path derivation
  3. `parseNdjsonLine` — valid system/init message
  4. `parseNdjsonLine` — valid assistant message
  5. `parseNdjsonLine` — valid result message
  6. `parseNdjsonLine` — empty line returns null
  7. `parseNdjsonLine` — invalid JSON returns null
  8. `parseNdjsonLine` — unknown type returns null
  9. `parseNdjsonLine` — missing type field returns null
  10. `spawnWorker` — spawns with correct args and env
  11. `spawnWorker` — parses NDJSON from stdout and emits message events
  12. `spawnWorker` — writes raw output to log file
  13. `spawnWorker` — emits spawned event
  14. `spawnWorker` — emits exited event with code
  15. `spawnWorker` — emits error event when claude not found
  16. `spawnWorker` — constructs prompt with context file
  17. `killWorker` — sends SIGTERM then SIGKILL if needed
  18. `killWorker` — no-op if process already dead

  For subprocess mocking: mock `node:child_process` spawn to return a fake ChildProcess with controllable stdout/stderr EventEmitter streams. Use `PassThrough` streams or manual EventEmitter to simulate NDJSON output.
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vitest`, `node:fs`, `node:path`, `node:os`, `node:events`, `node:stream`
- **GOTCHA**: Subprocess mocking is complex — need to simulate the ChildProcess interface with stdout/stderr as readable streams and process events (close, error). Use `PassThrough` from `node:stream` for stdout/stderr simulation.
- **VALIDATE**: `pnpm run test` — all tests pass

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| buildPrompt basic | `('10')` | `/pick-up #10` | No |
| buildPrompt with context | `('10', 'retry info')` | `/pick-up #10\n\nContext...` | No |
| getLogPath | `('pr-1', '10')` | `.orchestrator/logs/pr-1/10.log` | No |
| parseNdjsonLine system | `'{"type":"system","subtype":"init","session_id":"abc"}'` | NdjsonSystemMessage | No |
| parseNdjsonLine assistant | `'{"type":"assistant","message":"working"}'` | NdjsonAssistantMessage | No |
| parseNdjsonLine result | `'{"type":"result","result":"done","is_error":false}'` | NdjsonResultMessage | No |
| parseNdjsonLine empty | `''` | null | Yes |
| parseNdjsonLine invalid JSON | `'not json'` | null | Yes |
| parseNdjsonLine unknown type | `'{"type":"unknown"}'` | null | Yes |
| parseNdjsonLine no type | `'{"data":"value"}'` | null | Yes |
| spawnWorker args | valid inputs | correct spawn args/env | No |
| spawnWorker NDJSON | emit lines on stdout | message events | No |
| spawnWorker log capture | emit lines | written to log file | No |
| spawnWorker exit | process closes | exited event | No |
| spawnWorker error | ENOENT | error event | Yes |
| killWorker alive | valid PID | SIGTERM sent | No |
| killWorker dead | invalid PID | no-op | Yes |

### Edge Cases Checklist
- [x] Empty NDJSON line
- [x] Invalid JSON in stream
- [x] Unknown message type
- [x] Missing fields in message
- [x] Claude not found in PATH (ENOENT)
- [x] Process crash with non-zero exit
- [x] Process already dead on kill
- [x] SIGTERM timeout → SIGKILL escalation

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
EXPECT: All tests pass including new worker-manager tests

### Build
```bash
pnpm run build
```
EXPECT: Clean build

---

## Acceptance Criteria
- [x] `spawnWorker` spawns `claude -p` with correct args and env
- [x] Process CWD set to worktree path
- [x] Environment includes `ECC_HOOK_PROFILE=minimal` and `ECC_GATEGUARD=off`
- [x] Prompt constructed correctly with optional context file
- [x] NDJSON stream parsed line-by-line into typed objects
- [x] Handles `system/init`, `assistant`, `result` message types
- [x] `killWorker` sends SIGTERM, waits, then SIGKILL
- [x] Raw stdout captured to `.orchestrator/logs/<group>/<issue>.log`
- [x] Handles `claude` not found in PATH with clear error
- [x] Handles process crash with captured stderr
- [x] Tests use mock subprocess to verify NDJSON parsing and lifecycle

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Tests follow test patterns (temp dirs, vi.mock)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mock subprocess complexity | High | Medium | Use PassThrough streams to simulate stdout/stderr; keep mock surface minimal |
| NDJSON format drift | Low | Medium | Use discriminated union with null fallback for unknown types (forward-compatible) |
| Kill timing in tests | Medium | Low | Use vi.useFakeTimers for timeout-dependent kill tests |

## Notes
- The module uses a callback pattern (`onEvent`) rather than EventEmitter class extension to stay consistent with the functional style of the codebase (no classes used anywhere).
- `spawn` is used instead of `execFile` because we need streaming stdout access, not buffered output.
- The `'close'` event is used instead of `'exit'` to ensure stdout/stderr streams are fully consumed before processing the exit code.
- Log files use append mode (`flags: 'a'`) to support retry scenarios where a new worker writes to the same log file.
- The `stderrChunks` array captures stderr for potential use by the caller via the error event, but stderr is not written to the log file to keep logs clean for NDJSON parsing.
