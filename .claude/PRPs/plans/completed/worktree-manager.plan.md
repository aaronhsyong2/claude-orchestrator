# Plan: Worktree Manager

## Summary
Implement a Worktree Manager module that creates and removes git worktrees for isolated agent workspaces. Provides `create`, `remove`, `exists`, and `getPath` operations with deterministic path derivation from branch names, configurable base branch, and comprehensive error handling for resume scenarios.

## User Story
As the orchestrator scheduler, I want to create isolated git worktrees per PR group, so that agents work in separate directories without path conflicts.

## Problem → Solution
No worktree management exists — agents have no isolated workspace → A module wraps git worktree commands with deterministic paths, graceful error handling, and resume support.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A (issue #6 from PR plan)
- **Estimated Files**: 3 (types update, worktree-manager.ts, worktree-manager.test.ts)

---

## UX Design

N/A — internal module, no user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `src/status-manager.ts` | 1-176 | Closest analog — same file I/O, slug validation, atomic write, baseDir pattern |
| P0 (critical) | `src/types.ts` | 1-91 | All existing types — add new types here |
| P1 (important) | `src/config.ts` | 1-98 | Shows how `base_branch` is loaded from config |
| P1 (important) | `src/lock.ts` | 1-91 | Error handling pattern for OS-level operations (EEXIST, etc.) |
| P2 (reference) | `src/status-manager.test.ts` | 1-280 | Test structure, temp dir setup, factory helpers |
| P2 (reference) | `src/parser.test.ts` | 1-350 | Async test patterns, error assertions |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| git worktree | git-scm.com | `git worktree add <path> -b <branch> <base>` creates worktree; `git worktree remove <path>` removes it; `git worktree list --porcelain` for machine-readable listing |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/status-manager.ts:1-5
// Files: kebab-case (worktree-manager.ts)
// Functions: camelCase with verb prefixes (get*, read*, write*, create*, remove*)
// Types: PascalCase (WorktreeInfo)
// Constants: UPPER_SNAKE for regex/config
```

### ERROR_HANDLING
```typescript
// SOURCE: src/status-manager.ts:7-11
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertValidSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) {
		throw new Error(`Invalid slug "${slug}" — must be lowercase alphanumeric with hyphens`);
	}
}
```

### FILE_IO_PATTERN
```typescript
// SOURCE: src/status-manager.ts:48-68
// Graceful read: return null for missing files, throw for real errors
export function readGroupStatus(groupSlug: string, baseDir?: string): GroupStatus | null {
	// ... try/catch, return null on ENOENT
}
```

### BASEDIR_PATTERN
```typescript
// SOURCE: src/status-manager.ts:13-15
export function getGroupStatusPath(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/status', `${groupSlug}.json`);
}
```

### IMMUTABILITY
```typescript
// SOURCE: src/parser.ts:111
// Always spread to create new objects, never mutate
currentGroup = { ...currentGroup, branch: branchMatch[1] };
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/status-manager.test.ts:1-44
// Real temp dirs, factory helpers, fixed time injection
let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worktree-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWorktreeInfo(overrides?: Partial<WorktreeInfo>): WorktreeInfo {
	return { branch: 'feat/test', worktreePath: '/tmp/test', ...overrides };
}
```

### EXEC_PATTERN
```typescript
// SOURCE: src/lock.ts:20-25
// For shell command execution, use child_process.execFileSync or execFile
// Pattern from lock.ts process.kill — wrap OS calls in try/catch with typed errors
try {
	// OS operation
} catch (err: unknown) {
	if ((err as NodeJS.ErrnoException).code !== 'EXPECTED_CODE') {
		throw err;
	}
	// handle expected case
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add `WorktreeInfo` interface |
| `src/worktree-manager.ts` | CREATE | Core worktree operations module |
| `src/worktree-manager.test.ts` | CREATE | Tests with mocked git commands |

## NOT Building

- Deciding when to create/remove (that's the Scheduler #9)
- Branch naming logic (comes from PR plan parser #4)
- Git merge operations
- Integration with the CLI or scheduler
- Worktree cleanup on process crash (that's shutdown/resume #18)

---

## Step-by-Step Tasks

### Task 1: Add WorktreeInfo type to types.ts
- **ACTION**: Add a new interface at the end of types.ts
- **IMPLEMENT**:
  ```typescript
  export interface WorktreeInfo {
  	readonly branch: string;
  	readonly worktreePath: string;
  }
  ```
- **MIRROR**: NAMING_CONVENTION — PascalCase, readonly fields, same interface style as `ReconcileCorrection`
- **IMPORTS**: None — types.ts has no imports
- **GOTCHA**: Keep readonly throughout. Place after `ReconcileCorrection` at end of file.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create worktree-manager.ts with path derivation
- **ACTION**: Create `src/worktree-manager.ts` with `getWorktreePath` and `getWorktreeDir` helpers
- **IMPLEMENT**:
  ```typescript
  import * as path from 'node:path';

  const BRANCH_SLUG_RE = /[^a-z0-9-]/g;

  export function getWorktreeDir(baseDir?: string): string {
  	return path.resolve(baseDir ?? '.', '.orchestrator/worktrees');
  }

  export function getWorktreePath(branch: string, baseDir?: string): string {
  	const slug = branch.toLowerCase().replace(BRANCH_SLUG_RE, '-');
  	return path.join(getWorktreeDir(baseDir), slug);
  }
  ```
- **MIRROR**: BASEDIR_PATTERN, NAMING_CONVENTION
- **IMPORTS**: `node:path`
- **GOTCHA**: Branch names like `feat/my-branch` must become safe directory names — replace `/` and special chars with `-`
- **VALIDATE**: Unit test for slug derivation

### Task 3: Implement `exists` function
- **ACTION**: Add `exists(branch, baseDir?)` that checks if worktree is present
- **IMPLEMENT**:
  ```typescript
  import * as fs from 'node:fs';

  export function exists(branch: string, baseDir?: string): boolean {
  	const wtPath = getWorktreePath(branch, baseDir);
  	try {
  		fs.statSync(wtPath);
  		return true;
  	} catch {
  		return false;
  	}
  }
  ```
- **MIRROR**: FILE_IO_PATTERN — graceful return on missing
- **IMPORTS**: `node:fs`
- **GOTCHA**: Use `statSync` not `existsSync` — it throws on permission errors which we want to propagate naturally (stat throws EACCES vs existsSync silently returns false)
- **VALIDATE**: Test with existing and non-existing paths

### Task 4: Implement `getPath` function
- **ACTION**: Add `getPath(branch, baseDir?)` returning path or null
- **IMPLEMENT**:
  ```typescript
  export function getPath(branch: string, baseDir?: string): string | null {
  	const wtPath = getWorktreePath(branch, baseDir);
  	try {
  		fs.statSync(wtPath);
  		return wtPath;
  	} catch {
  		return null;
  	}
  }
  ```
- **MIRROR**: FILE_IO_PATTERN — null for missing
- **IMPORTS**: Already imported
- **GOTCHA**: Returns null not throws when worktree doesn't exist
- **VALIDATE**: Test returns path when exists, null when not

### Task 5: Implement `create` function
- **ACTION**: Add `create(branch, baseBranch, baseDir?)` that runs `git worktree add`
- **IMPLEMENT**:
  ```typescript
  import { execFileSync } from 'node:child_process';

  export function create(branch: string, baseBranch: string, baseDir?: string): string {
  	const wtPath = getWorktreePath(branch, baseDir);
  	const repoDir = path.resolve(baseDir ?? '.');

  	// If worktree already exists, return existing path
  	if (exists(branch, baseDir)) {
  		return wtPath;
  	}

  	// Ensure parent directory exists
  	fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  	// Verify base branch exists
  	try {
  		execFileSync('git', ['rev-parse', '--verify', baseBranch], {
  			cwd: repoDir,
  			stdio: 'pipe',
  		});
  	} catch {
  		throw new Error(`Base branch "${baseBranch}" does not exist`);
  	}

  	try {
  		execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, baseBranch], {
  			cwd: repoDir,
  			stdio: 'pipe',
  		});
  	} catch (err: unknown) {
  		const message = err instanceof Error ? err.message : String(err);
  		if (message.includes('No space left on device') || message.includes('Disk quota exceeded')) {
  			throw new Error(`Disk full — cannot create worktree at ${wtPath}`);
  		}
  		if (message.includes('Permission denied') || message.includes('EACCES')) {
  			throw new Error(`Permission denied — cannot create worktree at ${wtPath}`);
  		}
  		throw new Error(`Failed to create worktree for branch "${branch}": ${message}`);
  	}

  	return wtPath;
  }
  ```
- **MIRROR**: EXEC_PATTERN, ERROR_HANDLING
- **IMPORTS**: `node:child_process`
- **GOTCHA**: Must verify base branch BEFORE attempting worktree add, otherwise git error is cryptic. Use `stdio: 'pipe'` to capture stderr. If worktree already exists, return path (resume scenario).
- **VALIDATE**: Test with mocked execFileSync — verify correct git args

### Task 6: Implement `remove` function
- **ACTION**: Add `remove(branch, baseDir?)` that runs `git worktree remove` and `git branch -d`
- **IMPLEMENT**:
  ```typescript
  export function remove(branch: string, baseDir?: string): void {
  	const wtPath = getWorktreePath(branch, baseDir);
  	const repoDir = path.resolve(baseDir ?? '.');

  	// Remove worktree (if it exists)
  	if (exists(branch, baseDir)) {
  		try {
  			execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
  				cwd: repoDir,
  				stdio: 'pipe',
  			});
  		} catch (err: unknown) {
  			const message = err instanceof Error ? err.message : String(err);
  			throw new Error(`Failed to remove worktree at ${wtPath}: ${message}`);
  		}
  	}

  	// Delete branch
  	try {
  		execFileSync('git', ['branch', '-d', branch], {
  			cwd: repoDir,
  			stdio: 'pipe',
  		});
  	} catch {
  		// Branch may not exist or may already be deleted — not an error
  	}
  }
  ```
- **MIRROR**: EXEC_PATTERN, ERROR_HANDLING
- **IMPORTS**: Already imported
- **GOTCHA**: `--force` on worktree remove handles dirty worktrees. Branch delete failure is non-fatal (branch may already be merged/deleted).
- **VALIDATE**: Test verifies correct git commands called

### Task 7: Write tests for worktree-manager
- **ACTION**: Create `src/worktree-manager.test.ts` with comprehensive tests
- **IMPLEMENT**: Tests that mock `execFileSync` via `vi.mock('node:child_process')` and use real temp dirs for path-based operations. Cover:
  1. `getWorktreePath` — deterministic slug from branch name
  2. `getWorktreePath` — handles special characters in branch names
  3. `exists` — returns true when dir exists, false when not
  4. `getPath` — returns path when exists, null when not
  5. `create` — calls correct git commands in order
  6. `create` — returns existing path if worktree already exists (resume)
  7. `create` — throws on missing base branch
  8. `create` — throws clear error on disk full
  9. `create` — throws clear error on permission denied
  10. `remove` — calls git worktree remove then git branch -d
  11. `remove` — skips worktree remove if doesn't exist
  12. `remove` — doesn't throw if branch delete fails
- **MIRROR**: TEST_STRUCTURE — beforeEach/afterEach with temp dirs, factory helpers
- **IMPORTS**: `vitest` globals, `node:fs`, `node:path`, `node:os`
- **GOTCHA**: Mock `execFileSync` not the whole `child_process` module. Use `vi.spyOn` or `vi.mock` with factory. Need to handle the interplay between real filesystem (for `exists`/`getPath`) and mocked git commands (for `create`/`remove`).
- **VALIDATE**: `pnpm run test` — all tests pass

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| getWorktreePath deterministic | `'feat/my-branch'` | `.orchestrator/worktrees/feat-my-branch` | No |
| getWorktreePath special chars | `'feat/UPPER_case.dots'` | `.orchestrator/worktrees/feat-upper-case-dots` | Yes |
| exists returns true | dir exists at worktree path | `true` | No |
| exists returns false | no dir at worktree path | `false` | No |
| getPath returns path | dir exists | full path string | No |
| getPath returns null | no dir | `null` | No |
| create happy path | valid branch + base | worktree path, git commands called | No |
| create resume | worktree already exists | existing path, no git calls | Yes |
| create missing base | invalid baseBranch | throws "does not exist" | Yes |
| create disk full | git fails with space error | throws "Disk full" | Yes |
| create permission denied | git fails with EACCES | throws "Permission denied" | Yes |
| remove happy path | existing worktree | git worktree remove + branch -d called | No |
| remove no worktree | worktree doesn't exist | only branch -d called | Yes |
| remove branch already deleted | branch -d fails | no throw | Yes |

### Edge Cases Checklist
- [x] Existing worktree (resume scenario)
- [x] Missing base branch
- [x] Disk full
- [x] Permission denied
- [x] Special characters in branch names
- [x] Branch already deleted on remove

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
EXPECT: All tests pass including new worktree-manager tests

### Build
```bash
pnpm run build
```
EXPECT: Clean build

---

## Acceptance Criteria
- [x] `create()` runs `git worktree add` with correct branch and base
- [x] Worktree path is deterministic from branch name
- [x] Branch created from configured `base_branch`
- [x] `remove()` runs `git worktree remove` and `git branch -d`
- [x] `exists()` checks if worktree already exists
- [x] `getPath()` returns filesystem path of existing worktree
- [x] Handles existing worktree gracefully (returns path, no crash)
- [x] Handles missing base branch with clear error
- [x] Handles disk full / permission denied with clear error
- [x] Tests mock git commands and verify arguments

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Tests follow test patterns (temp dirs, factory helpers)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mocking `execFileSync` while keeping real `fs` | Medium | Medium | Use `vi.mock` with selective mocking, keep `fs` real for path tests |
| Branch name edge cases (unicode, very long names) | Low | Low | Regex-based slug handles most cases; add tests for edge cases |

## Notes
- The module is deliberately stateless — it wraps git commands and filesystem checks. The Scheduler (#9) decides when to call these functions.
- `--force` on `git worktree remove` is intentional — the orchestrator owns these worktrees and should be able to clean them up regardless of dirty state.
- Branch deletion after worktree removal is best-effort — the branch may have been merged upstream already.
