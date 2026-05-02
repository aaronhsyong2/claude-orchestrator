# Plan: PR Plan Parser

## Summary
Parse PR plan markdown documents (format defined in `FORMAT.md`) into structured `PlanData`. Extract PR groups with branches, statuses, issue lists, cross-group dependencies, and intra-group dependencies from issue `## Blocked by` sections. Build a dependency graph with topological ordering.

## User Story
As the orchestrator scheduler, I want parsed PR plan data with a dependency graph, so that I can schedule agent work in the correct order.

## Problem → Solution
No PR plan parsing exists — the orchestrator cannot read its input format → A `parse(filePath)` function that returns typed `PlanData` with dependency graph.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (Issue #4)
- **PRD Phase**: N/A
- **Estimated Files**: 4 (types update, parser, dependency graph, tests)

---

## UX Design

N/A — internal change, no user-facing UX transformation.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `src/types.ts` | all | Existing type conventions (readonly, snake_case fields) |
| P0 (critical) | `FORMAT.md` (external) | all | PR plan format contract with regex patterns |
| P1 (important) | `src/config.ts` | all | Pattern for file reading, validation, error handling |
| P1 (important) | `src/status.ts` | all | Pattern for validation guards, readonly arrays |
| P2 (reference) | `src/config.test.ts` | all | Test patterns: tmpDir, beforeEach/afterEach, describe/it |
| P2 (reference) | `src/status.test.ts` | all | Test patterns for parsing and edge cases |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| None needed | — | Feature uses established internal patterns and Node.js fs/readline |

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/types.ts:1-36, src/config.ts:1-4
```typescript
// Types: PascalCase interfaces, readonly fields, snake_case field names
export interface StatusEntry {
	readonly slug: string;
	readonly state: AgentState;
	readonly issues_total: number;
	readonly issues_done: number;
}
// Imports: `import * as fs from 'node:fs';`
// Exports: named exports, no default exports
// File extensions: `.js` in import paths
```

### ERROR_HANDLING
// SOURCE: src/config.ts:66-84
```typescript
// Separate try/catch for each failure mode, specific error messages
export function loadConfig(baseDir?: string): OrchestratorConfig {
	let content: string;
	try {
		content = fs.readFileSync(configPath, 'utf-8');
	} catch {
		throw new Error(`Failed to read config at ${configPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in config at ${configPath}`);
	}
}
```

### VALIDATION_PATTERN
// SOURCE: src/status.ts:14-23
```typescript
// Type guard functions with runtime checks
function isValidStatusEntry(value: unknown): value is StatusEntry {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.slug === 'string' &&
		typeof obj.state === 'string' &&
		VALID_STATES.includes(obj.state as AgentState)
	);
}
```

### WARNING_PATTERN
// SOURCE: src/status.ts:38-41
```typescript
// Warn on malformed data, skip rather than crash
process.stderr.write(`Warning: skipping malformed status file ${file}\n`);
```

### TEST_STRUCTURE
// SOURCE: src/config.test.ts:1-20, src/status.test.ts:1-12
```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-parser-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Group by function name with describe()
// One assertion per it() block
// Test happy path, then edge cases, then error cases
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types.ts` | UPDATE | Add PlanData, PRGroup, IssueRef, DependencyGraph types |
| `src/parser.ts` | CREATE | PR plan markdown parser — `parsePlan(filePath)` |
| `src/graph.ts` | CREATE | Dependency graph construction + topological sort |
| `src/parser.test.ts` | CREATE | Unit tests for parser against fixture files |
| `src/graph.test.ts` | CREATE | Unit tests for dependency graph and topo sort |

## NOT Building

- Writing or modifying PR plan files
- Scheduling logic (Issue #9)
- GitHub issue creation or modification
- Intra-group dependency fetching via `gh issue view` (deferred — parser accepts pre-fetched blockers or returns issue refs for the scheduler to resolve)
- Local issue source parsing (only GitHub `#N` refs for now)

---

## Step-by-Step Tasks

### Task 1: Add types to types.ts
- **ACTION**: Append new types for PR plan data structures
- **IMPLEMENT**:
```typescript
export type PRGroupStatus = 'pending' | 'in-progress' | 'done' | 'merged';

export interface IssueRef {
	readonly number: number;
	readonly title: string;
	readonly status: string;
}

export interface PRGroup {
	readonly pr_number: number;
	readonly title: string;
	readonly branch: string;
	readonly status: PRGroupStatus;
	readonly issues: readonly IssueRef[];
	readonly depends_on: readonly number[]; // cross-group PR numbers
}

export interface PlanData {
	readonly title: string;
	readonly groups: readonly PRGroup[];
}

export interface DependencyGraph {
	readonly adjacency: ReadonlyMap<number, readonly number[]>;
	readonly order: readonly number[];
}
```
- **MIRROR**: NAMING_CONVENTION — readonly fields, snake_case, PascalCase interfaces
- **IMPORTS**: None (pure type definitions)
- **GOTCHA**: Use `readonly` on all fields and arrays per codebase convention
- **VALIDATE**: `pnpm run typecheck` passes

### Task 2: Create parser.ts
- **ACTION**: Create `src/parser.ts` with `parsePlan(filePath)` function
- **IMPLEMENT**:
  - Read file with `fs.readFileSync`
  - Split into lines and iterate once
  - Match PR group headings: `/^## PR (\d+): (.+)$/`
  - Match branch: `/\*\*Branch:\*\*\s*`([^`]+)`/`
  - Match status: `/\*\*Status:\*\*\s*(\w[\w-]*)/`
  - Match issue refs: `/\| #(\d+) \|/` (extract from table rows, also capture title and status columns)
  - Match dependency notes: `/^>\s*Depends on:\s*(.+)$/` → parse `PR N` references
  - Match standalone section: `/^## Standalone$/` → parse issues as single-issue groups
  - Filter out groups with status `done` or `merged` from active groups
  - Return `PlanData` with all groups (including filtered) — let consumer decide
- **MIRROR**: ERROR_HANDLING, VALIDATION_PATTERN
- **IMPORTS**: `import * as fs from 'node:fs';`, `import type { ... } from './types.js';`
- **GOTCHA**: Issue table has `| Issue | Title | Status |` header row + separator — skip those. Standalone section has different columns `| Issue | Title | Notes |`.
- **VALIDATE**: `pnpm run typecheck` passes, parser returns correct types

### Task 3: Create graph.ts
- **ACTION**: Create `src/graph.ts` with dependency graph builder
- **IMPLEMENT**:
  - `buildDependencyGraph(groups: readonly PRGroup[]): DependencyGraph`
  - Build adjacency map: for each group, map `pr_number` → `depends_on` array
  - Topological sort using Kahn's algorithm (BFS-based, stable ordering)
  - Detect cycles and throw descriptive error with the cycle path
  - Only include groups that are not `done`/`merged` in the graph
- **MIRROR**: NAMING_CONVENTION, ERROR_HANDLING
- **IMPORTS**: `import type { PRGroup, DependencyGraph } from './types.js';`
- **GOTCHA**: A group may depend on a `done`/`merged` group — that dependency is satisfied, treat as no-dep. Cycle detection is critical — scheduler will deadlock without it.
- **VALIDATE**: `pnpm run typecheck` passes

### Task 4: Create parser.test.ts
- **ACTION**: Create `src/parser.test.ts` with unit tests
- **IMPLEMENT**: Tests using fixture markdown files written to tmpDir:
  1. Parses complete PR plan with multiple groups
  2. Extracts branch names from backtick-wrapped values
  3. Extracts status values
  4. Extracts issue references with title and status
  5. Parses cross-group dependencies from `> Depends on: PR N` lines
  6. Parses standalone section as single-issue groups
  7. Handles empty groups (heading but no issues)
  8. Handles missing branch field (defaults to empty string)
  9. Handles malformed markdown (returns parse errors array, not crash)
  10. Throws on file not found
  11. Handles groups with `done`/`merged` status (still parsed, included in output)
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { parsePlan } from './parser.js';`
- **GOTCHA**: Write realistic fixture markdown matching FORMAT.md exactly — include frontmatter, header row, separator row
- **VALIDATE**: `pnpm run test` — all tests pass

### Task 5: Create graph.test.ts
- **ACTION**: Create `src/graph.test.ts` with unit tests
- **IMPLEMENT**:
  1. Builds graph from groups with no dependencies (all in order)
  2. Respects dependency ordering (dependent group comes after dependency)
  3. Handles diamond dependencies (A→B, A→C, B→D, C→D)
  4. Detects and throws on circular dependencies
  5. Excludes `done`/`merged` groups from graph
  6. Handles group depending on `done` group (treated as satisfied)
  7. Empty groups array returns empty graph
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { buildDependencyGraph } from './graph.js';`, `import type { PRGroup } from './types.js';`
- **GOTCHA**: Create helper function to build minimal PRGroup objects for tests
- **VALIDATE**: `pnpm run test` — all tests pass

### Task 6: Verify all checks pass
- **ACTION**: Run full validation suite
- **VALIDATE**: `pnpm run check && pnpm run typecheck && pnpm run build && pnpm run test`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Parse complete plan | Full FORMAT.md example | 2 groups + 1 standalone | No |
| Parse branch | `**Branch:** \`feat/foo\`` | `"feat/foo"` | No |
| Parse status | `**Status:** pending` | `"pending"` | No |
| Parse issue refs | `\| #30 \| Title \| Open \|` | `{ number: 30, title: "Title", status: "Open" }` | No |
| Parse dependencies | `> Depends on: PR 1` | `depends_on: [1]` | No |
| Parse multi-dep | `> Depends on: PR 1, PR 3` | `depends_on: [1, 3]` | No |
| Parse standalone | `## Standalone` section | Single-issue groups | No |
| Empty group | Heading, no table rows | Group with empty issues array | Yes |
| Missing branch | No Branch line | `branch: ""` | Yes |
| File not found | Bad path | Throws with message | Yes |
| Topo sort basic | Linear chain | Correct order | No |
| Topo sort diamond | Diamond deps | Valid topo order | No |
| Cycle detection | A→B→A | Throws with cycle info | Yes |
| Done group excluded | Group with status `done` | Not in graph order | No |

### Edge Cases Checklist
- [x] Empty input (no groups)
- [x] Missing optional fields (branch)
- [x] Circular dependencies
- [x] Groups depending on completed groups
- [x] Malformed markdown lines (skip, don't crash)
- [x] Multiple dependency notes
- [x] Standalone section mixed with regular groups

---

## Validation Commands

### Static Analysis
```bash
pnpm run check
```
EXPECT: Zero lint errors

### Type Check
```bash
pnpm run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm run test
```
EXPECT: All tests pass

### Build
```bash
pnpm run build
```
EXPECT: Clean build

---

## Acceptance Criteria
- [ ] `parsePlan(filePath)` returns typed `PlanData` containing array of PR groups
- [ ] Each PR group has: number, title, branch name, status, array of issue references
- [ ] Cross-group dependencies extracted from `> Depends on: PR N` lines
- [ ] Groups with status `done` or `merged` are parsed but excluded from dependency graph
- [ ] Standalone issues parsed as single-issue PR groups
- [ ] `buildDependencyGraph()` returns dependency graph with topological ordering
- [ ] Handles edge cases: empty groups, missing branch field, malformed markdown
- [ ] Tests against realistic PR plan fixture files with known expected output
- [ ] All validation commands pass

## Completion Checklist
- [ ] Code follows discovered patterns (readonly, snake_case, named exports)
- [ ] Error handling matches codebase style (separate try/catch, specific messages)
- [ ] No console.log in production code
- [ ] Tests follow test patterns (tmpDir, describe/it, vitest imports)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FORMAT.md changes | Low | Medium | Parser follows FORMAT.md regex exactly; update parser if format changes |
| Cycle in real plan | Low | High | Kahn's algorithm detects cycles; clear error message with cycle path |
| Large plan files | Low | Low | Single-pass line iteration; no memory concern for realistic plan sizes |

## Notes
- Intra-group dependency fetching via `gh issue view` is deferred. Parser returns issue refs; the scheduler (#9) will resolve blockers at runtime. This keeps the parser pure (no network calls) and testable.
- `PlanData.groups` includes ALL groups (including done/merged). The `DependencyGraph` filters to active groups only. This gives consumers flexibility.
- Standalone issues get `pr_number: 0` and title from the issue title column. The graph builder skips them unless they have explicit dependencies.
