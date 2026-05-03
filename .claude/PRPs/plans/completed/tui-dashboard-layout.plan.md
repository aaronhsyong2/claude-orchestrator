# Plan: TUI Dashboard — Lazygit-style Layout

## Summary
Implement a fullscreen Ink TUI dashboard with a Lazygit-style layout: left sidebar (~33%) containing PR Groups, Issues, and Activity panels, and a main view (~67%) showing context-sensitive detail. Polls `.orchestrator/status/*.json` for live state. Visual-only — keyboard navigation deferred to #12.

## User Story
As a developer running the orchestrator,
I want a real-time TUI dashboard showing PR group progress,
So that I can monitor autonomous agent work at a glance.

## Problem → Solution
Console-only progress output → Fullscreen TUI with structured panels, status icons, progress bars, and live polling.

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A (GitHub issue #11)
- **PRD Phase**: N/A
- **Estimated Files**: 14

---

## UX Design

### Before
```
$ orchestrator start plan.md
Acquired lock (.orchestrator/lock, PID 12345)
Starting PR 5: TUI Dashboard [feat/tui-dashboard]
  Issue #11: cloning...
  Issue #11: implementing...
  Issue #11: verifying...
  Issue #11: done
```

### After
```
┌─ PR Groups ─────────────┬─ PR 5: TUI Dashboard ──────────────────────┐
│ ✓ PR 1: Foundation      │                                             │
│ ✓ PR 2: Core Data       │  Branch: feat/tui-dashboard                 │
│ ✓ PR 3: Infrastructure  │  Status: in-progress                        │
│ ⚙ PR 5: TUI Dashboard   │  Progress: 1/4 issues                       │
│ · PR 6: Resilience      │                                             │
│ · PR 7: Shutdown        │  Issues:                                    │
├─ Issues (#5) ───────────┤  ⚙ #11 TUI Dashboard layout     [coding]   │
│ ⚙ #11 Layout  [coding]  │  · #12 Navigation                           │
│ · #12 Navigation        │  · #13 Interactive takeover                  │
│ · #13 Takeover          │  · #14 Notification service                  │
│ · #14 Notifications     │                                             │
├─ Activity ──────────────┤  Current Step: coding                        │
│ 13:42 #11 coding        │  Last Updated: 2026-05-03T13:42:00Z         │
│ 13:41 #11 cloning       │                                             │
│ 13:40 PR 5 started      │                                             │
└─────────────────────────┴─────────────────────────────────────────────┘
 q quit │ ↑↓ select │ ←→ panel │ enter details
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Start orchestration | Console logs | Fullscreen TUI | Alt screen buffer |
| View progress | Scroll terminal | Structured panels | Live polling |
| Exit | Ctrl+C | q or Ctrl+C | Restore terminal |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types.ts:44-94` | GroupStatus, PRGroup, AgentState types | Core data model for dashboard |
| P0 | `src/status-manager.ts:1-55` | readGroupStatus, validation | How to read status files |
| P0 | `src/status.ts:1-69` | readStatusFiles, formatStatus | Existing status reading pattern |
| P1 | `src/cli.tsx:1-103` | CLI entry point | Where dashboard command hooks in |
| P1 | `src/orchestrate.ts:1-97` | orchestrate function | How orchestration emits progress |
| P2 | `src/slug.ts:1-41` | deriveSlug, validateBranchName | Slug conventions |
| P2 | `src/parser.ts:1-30` | PR plan parsing | Understanding PlanData shape |
| P2 | `src/status-manager.test.ts:1-50` | Test patterns | makeStatus helper, tmpDir setup |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Ink 7 Box layout | vadimdemedes/ink | `<Box width="33%">` for percentage widths, `borderStyle="single"` for panels |
| Ink useInput | vadimdemedes/ink | `useInput((input, key) => {})` — out of scope for #11 but footer hints reference it |
| ink-testing-library | vadimdemedes/ink | `render(<Comp />)` returns `lastFrame()` for snapshot assertions |
| fullscreen-ink | daniguardiola/fullscreen-ink | `withFullScreen(<App />).start()` for alt screen + `useScreenSize()` for responsive |
| @inkjs/ui ProgressBar | vadimdemedes/ink-ui | `<ProgressBar value={50} />` for group progress display |
| @inkjs/ui Spinner | vadimdemedes/ink-ui | `<Spinner label="..." />` for active step indication |

---

## Patterns to Mirror

### NAMING_CONVENTION
```ts
// SOURCE: src/status-manager.ts:1-4
// Files: kebab-case (status-manager.ts)
// Functions: camelCase (readGroupStatus)
// Types: PascalCase (GroupStatus)
// Constants: UPPER_SNAKE (VALID_STEPS)
// React components: PascalCase files in tui/ dir (Dashboard.tsx)
```

### ERROR_HANDLING
```ts
// SOURCE: src/status-manager.ts:47-54
// Pattern: try/catch with stderr warning, return null for graceful degradation
try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (isValidGroupStatus(parsed)) {
        return parsed;
    }
    process.stderr.write(`Warning: skipping malformed group status file ${groupSlug}.json\n`);
    return null;
} catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: skipping invalid group status file ${groupSlug}.json — ${message}\n`);
    return null;
}
```

### IMMUTABLE_DATA
```ts
// SOURCE: src/types.ts:85-94
// All interfaces use `readonly` fields and `readonly` arrays
export interface GroupStatus {
    readonly pr_group: string;
    readonly branch: string;
    readonly current_issue: number | null;
    readonly step: GroupStep;
    // ...
}
```

### TEST_STRUCTURE
```ts
// SOURCE: src/status-manager.test.ts:1-39
// Pattern: vitest, tmpDir with beforeEach/afterEach, helper factories
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sm-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStatus(overrides?: Partial<GroupStatus>): GroupStatus {
    return { ...defaults, ...overrides };
}
```

### MODULE_EXPORTS
```ts
// SOURCE: src/status-manager.ts
// Pattern: named exports only, no default exports
export function readGroupStatus(...): GroupStatus | null { }
export function writeGroupStatus(...): void { }
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/tui/Panel.tsx` | CREATE | Reusable bordered panel with active/inactive styling |
| `src/tui/StatusIcon.tsx` | CREATE | Map GroupStep/state to status icon characters |
| `src/tui/use-status-poller.ts` | CREATE | Hook to poll .orchestrator/status/*.json |
| `src/tui/types.ts` | CREATE | TUI-specific types (ActivityEvent, DashboardState) |
| `src/tui/PRGroupsPanel.tsx` | CREATE | PR Groups list with icons and progress |
| `src/tui/IssuesPanel.tsx` | CREATE | Issues for selected PR group |
| `src/tui/ActivityPanel.tsx` | CREATE | Recent activity event log |
| `src/tui/MainView.tsx` | CREATE | Context-sensitive detail for selected group |
| `src/tui/Footer.tsx` | CREATE | Keybinding hint bar |
| `src/tui/Sidebar.tsx` | CREATE | Sidebar container stacking 3 panels |
| `src/tui/Dashboard.tsx` | CREATE | Root component composing Sidebar + MainView + Footer |
| `src/tui/Dashboard.test.tsx` | CREATE | Snapshot tests for layout at various sizes |
| `src/cli.tsx` | UPDATE | Add `dashboard` command rendering Ink app |
| `package.json` | UPDATE | Add fullscreen-ink, @inkjs/ui, ink-testing-library |

## NOT Building

- Keyboard navigation between panels/items (issue #12)
- Interactive takeover / neovim integration (issue #13)
- Notification service / macOS system notifications (issue #14)
- Real orchestration integration (dashboard reads status files only)
- Log panels or dependency graph visualization (#12)
- useInput key handlers (just show hints in footer)

---

## Step-by-Step Tasks

### Task 1: Add dependencies
- **ACTION**: Install fullscreen-ink, @inkjs/ui, ink-testing-library
- **IMPLEMENT**: `pnpm add fullscreen-ink @inkjs/ui && pnpm add -D ink-testing-library`
- **MIRROR**: package.json existing structure
- **IMPORTS**: N/A
- **GOTCHA**: fullscreen-ink must be compatible with Ink 7. Verify peer deps.
- **VALIDATE**: `pnpm ls fullscreen-ink @inkjs/ui ink-testing-library`

### Task 2: Create TUI types
- **ACTION**: Create `src/tui/types.ts` with dashboard-specific types
- **IMPLEMENT**:
  ```ts
  import type { GroupStatus } from '../types.js';

  export interface ActivityEvent {
      readonly timestamp: string;
      readonly message: string;
  }

  export interface DashboardState {
      readonly groups: readonly GroupStatus[];
      readonly activePanel: number;       // 0=PRGroups, 1=Issues, 2=Activity
      readonly selectedGroupIndex: number;
      readonly selectedIssueIndex: number;
  }

  export type StatusIconChar = '✓' | '⚙' | '⏸' | '⚠' | '·';
  ```
- **MIRROR**: IMMUTABLE_DATA — all readonly
- **IMPORTS**: `../types.js`
- **VALIDATE**: `pnpm typecheck`

### Task 3: Create StatusIcon utility
- **ACTION**: Create `src/tui/StatusIcon.tsx` — pure function mapping step/state to icon
- **IMPLEMENT**:
  ```tsx
  import type { GroupStep } from '../types.js';
  import type { StatusIconChar } from './types.js';

  export function getStatusIcon(step: GroupStep, result: string): StatusIconChar {
      if (step === 'idle' && result === 'pass') return '✓';
      if (step === 'idle' && result === 'blocked') return '⏸';
      if (step === 'idle' && result === 'needs-input') return '⚠';
      if (step === 'idle') return '·';
      return '⚙';  // cloning, coding, verifying, reviewing
  }

  // For PR group level: derive from issues_completed vs issues_remaining
  export function getGroupIcon(completed: number, remaining: number, step: GroupStep): StatusIconChar {
      if (remaining === 0 && completed > 0) return '✓';
      if (step !== 'idle') return '⚙';
      return '·';
  }
  ```
- **MIRROR**: MODULE_EXPORTS — named exports
- **VALIDATE**: Unit tests in Dashboard.test.tsx

### Task 4: Create use-status-poller hook
- **ACTION**: Create `src/tui/use-status-poller.ts` — polls status dir on interval
- **IMPLEMENT**:
  ```ts
  import { useEffect, useState } from 'react';
  import * as fs from 'node:fs';
  import * as path from 'node:path';
  import type { GroupStatus } from '../types.js';

  // Re-use validation logic from status-manager but import would create coupling
  // Instead, read all .json files and parse GroupStatus shape
  export function useStatusPoller(baseDir: string, intervalMs = 2000): readonly GroupStatus[] {
      const [groups, setGroups] = useState<readonly GroupStatus[]>([]);

      useEffect(() => {
          function poll() {
              // Read .orchestrator/status/*.json
              // Parse and validate each
              // setGroups(validEntries)
          }
          poll(); // Initial read
          const timer = setInterval(poll, intervalMs);
          return () => clearInterval(timer);
      }, [baseDir, intervalMs]);

      return groups;
  }
  ```
- **MIRROR**: ERROR_HANDLING — graceful degradation on bad files
- **IMPORTS**: `react`, `node:fs`, `node:path`, `../status-manager.js` for readGroupStatus
- **GOTCHA**: Must handle missing status dir (empty state). Don't crash on malformed JSON.
- **VALIDATE**: Hook returns empty array when no status files exist

### Task 5: Create Panel component
- **ACTION**: Create `src/tui/Panel.tsx` — reusable bordered panel
- **IMPLEMENT**:
  ```tsx
  import { Box, Text } from 'ink';
  import type { ReactNode } from 'react';

  interface PanelProps {
      readonly title: string;
      readonly active: boolean;
      readonly children: ReactNode;
      readonly height?: number | string;
  }

  export function Panel({ title, active, children, height }: PanelProps): ReactNode {
      return (
          <Box
              flexDirection="column"
              borderStyle="single"
              borderColor={active ? 'green' : undefined}
              borderDimColor={!active}
              height={height}
          >
              <Box>
                  <Text bold={active} color={active ? 'green' : undefined}>
                      {` ${title} `}
                  </Text>
              </Box>
              {children}
          </Box>
      );
  }
  ```
- **MIRROR**: NAMING_CONVENTION — PascalCase component, named export
- **GOTCHA**: Ink Box borderStyle doesn't support bold directly — use `borderStyle="bold"` for active or `borderStyle="single"` with color
- **VALIDATE**: Renders with correct border in snapshot test

### Task 6: Create PRGroupsPanel
- **ACTION**: Create `src/tui/PRGroupsPanel.tsx`
- **IMPLEMENT**: List each group with status icon, title, and progress fraction. Selected item gets blue background (active panel) or bold (inactive). Use `<Panel>` wrapper.
- **MIRROR**: IMMUTABLE_DATA, NAMING_CONVENTION
- **IMPORTS**: `ink`, `./Panel.js`, `./StatusIcon.js`, `./types.js`
- **GOTCHA**: Handle empty groups array → show "No groups"
- **VALIDATE**: Snapshot test with 0, 1, and 3 groups

### Task 7: Create IssuesPanel
- **ACTION**: Create `src/tui/IssuesPanel.tsx`
- **IMPLEMENT**: Show issues for selected PR group. Each issue shows status icon, number, title, current step. Panel title includes group reference.
- **MIRROR**: Same patterns as PRGroupsPanel
- **IMPORTS**: `ink`, `./Panel.js`, `./StatusIcon.js`
- **GOTCHA**: When no group selected or group has no issues, show empty state
- **VALIDATE**: Snapshot test

### Task 8: Create ActivityPanel
- **ACTION**: Create `src/tui/ActivityPanel.tsx`
- **IMPLEMENT**: Show recent ActivityEvent entries with timestamp and message. Most recent first. Cap at ~10 visible entries.
- **MIRROR**: Panel pattern
- **IMPORTS**: `ink`, `./Panel.js`, `./types.js`
- **GOTCHA**: Activity events derived from status changes, not stored. Build from polling diffs.
- **VALIDATE**: Snapshot test with empty and populated activity

### Task 9: Create MainView
- **ACTION**: Create `src/tui/MainView.tsx`
- **IMPLEMENT**: Show detail for selected PR group: branch, status, progress fraction, issue list with statuses, current step, last updated. Use `<Panel>` with title = group name.
- **MIRROR**: Panel pattern, StatusIcon
- **IMPORTS**: `ink`, `./Panel.js`, `./StatusIcon.js`, `@inkjs/ui` ProgressBar
- **GOTCHA**: Handle null selected group → "Select a PR group" message
- **VALIDATE**: Snapshot test

### Task 10: Create Footer
- **ACTION**: Create `src/tui/Footer.tsx`
- **IMPLEMENT**: Single row showing keybinding hints. Dim color. Context-sensitive based on active panel.
- **MIRROR**: NAMING_CONVENTION
- **IMPORTS**: `ink`
- **VALIDATE**: Snapshot test

### Task 11: Create Sidebar
- **ACTION**: Create `src/tui/Sidebar.tsx`
- **IMPLEMENT**: Stack PRGroupsPanel, IssuesPanel, ActivityPanel vertically. Distribute height proportionally.
- **MIRROR**: NAMING_CONVENTION
- **IMPORTS**: `ink`, panel components
- **VALIDATE**: Snapshot test

### Task 12: Create Dashboard (root component)
- **ACTION**: Create `src/tui/Dashboard.tsx`
- **IMPLEMENT**:
  ```tsx
  import { Box } from 'ink';
  import { FullScreenBox, useScreenSize } from 'fullscreen-ink';
  import { Sidebar } from './Sidebar.js';
  import { MainView } from './MainView.js';
  import { Footer } from './Footer.js';
  import { useStatusPoller } from './use-status-poller.js';

  export function Dashboard({ baseDir }: { readonly baseDir: string }): ReactNode {
      const groups = useStatusPoller(baseDir);
      const { width, height } = useScreenSize();
      // Default: first panel active, first group selected
      // Navigation deferred to #12

      return (
          <Box flexDirection="column" width={width} height={height}>
              <Box flexDirection="row" flexGrow={1}>
                  <Box width="33%">
                      <Sidebar groups={groups} activePanel={0} selectedGroupIndex={0} />
                  </Box>
                  <Box width="67%">
                      <MainView group={groups[0] ?? null} />
                  </Box>
              </Box>
              <Footer activePanel={0} />
          </Box>
      );
  }
  ```
- **MIRROR**: All patterns
- **GOTCHA**: fullscreen-ink's `useScreenSize` only works inside `withFullScreen` context. For tests, mock dimensions.
- **VALIDATE**: Full snapshot test

### Task 13: Update CLI with dashboard command
- **ACTION**: Update `src/cli.tsx` to add `dashboard` subcommand
- **IMPLEMENT**: Add case for `dashboard` that calls `withFullScreen(<Dashboard baseDir="." />).start()`
- **MIRROR**: CLI switch/case pattern from existing commands
- **IMPORTS**: `fullscreen-ink`, `./tui/Dashboard.js`
- **GOTCHA**: Don't break existing init/start/status commands. Dashboard runs standalone.
- **VALIDATE**: `pnpm dev dashboard` launches TUI

### Task 14: Write snapshot tests
- **ACTION**: Create `src/tui/Dashboard.test.tsx`
- **IMPLEMENT**: Use ink-testing-library `render()` + `lastFrame()` for snapshots. Test:
  - Empty state (no status files) → "Waiting for work..."
  - Single group with issues
  - Multiple groups with mixed states
  - StatusIcon mapping
  - Panel active/inactive styling
- **MIRROR**: TEST_STRUCTURE — vitest describe/it, helper factories
- **IMPORTS**: `ink-testing-library`, `vitest`, components
- **GOTCHA**: Can't use fullscreen-ink in tests. Test individual components, not Dashboard root. Mock useScreenSize if needed.
- **VALIDATE**: `pnpm test`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| getStatusIcon('idle', 'pass') | step=idle, result=pass | '✓' | No |
| getStatusIcon('coding', '') | step=coding | '⚙' | No |
| getGroupIcon(3, 0, 'idle') | all done | '✓' | No |
| Panel active=true | active prop | green bold border | No |
| Panel active=false | inactive prop | dim border | No |
| PRGroupsPanel empty | [] groups | "No groups" text | Yes |
| PRGroupsPanel 3 groups | mixed states | correct icons per group | No |
| IssuesPanel no group | null group | empty state message | Yes |
| MainView null group | null | "Waiting for work..." | Yes |
| MainView with group | GroupStatus | branch, progress, issues | No |
| ActivityPanel empty | [] events | empty panel | Yes |
| useStatusPoller no dir | missing dir | empty array | Yes |

### Edge Cases Checklist
- [x] Empty input (no status files → "Waiting for work...")
- [ ] Maximum size input (many groups/issues — scrolling deferred to #12)
- [x] Invalid types (malformed JSON → graceful skip)
- [x] Missing status directory
- [ ] Concurrent access (read-only, not a concern)
- [ ] Network failure (N/A — local files only)
- [ ] Permission denied (degrade gracefully)

---

## Validation Commands

### Static Analysis
```bash
pnpm typecheck
```
EXPECT: Zero type errors

### Linting
```bash
pnpm check
```
EXPECT: No Biome errors

### Unit Tests
```bash
pnpm test
```
EXPECT: All tests pass

### Manual Validation
- [ ] `pnpm dev dashboard` launches fullscreen TUI
- [ ] Empty state shows "Waiting for work..." when no status files
- [ ] Create mock status files in `.orchestrator/status/` and verify they appear
- [ ] Active panel has green border
- [ ] Footer shows keybinding hints
- [ ] Ctrl+C exits cleanly, restores terminal
- [ ] q exits cleanly (if implemented — may defer to #12)

---

## Acceptance Criteria
- [ ] Ink app renders Lazygit-style layout: left sidebar + main view
- [ ] PR Groups panel shows all groups with status icons and progress bars
- [ ] Issues panel updates to show issues for currently selected PR group
- [ ] Activity panel shows recent events
- [ ] Main view shows detail for selected PR group
- [ ] Status polled from `.orchestrator/status/*.json` every 1-3 seconds
- [ ] Active panel border is green bold; inactive panels default border
- [ ] Selected item in active panel has blue background; selected in inactive has bold
- [ ] Footer bar shows context-sensitive keybinding hints
- [ ] Handles empty state gracefully
- [ ] Ink snapshot tests for layout

## Completion Checklist
- [ ] Code follows discovered patterns (readonly, named exports, camelCase)
- [ ] Error handling matches codebase style (stderr warnings, graceful null)
- [ ] Tests follow test patterns (vitest, describe/it, helpers)
- [ ] No hardcoded values (poll interval configurable)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| fullscreen-ink incompatible with Ink 7 | Low | High | Check peer deps before installing; fallback to manual useStdout dimensions |
| ink-testing-library missing Ink 7 support | Low | Medium | Use manual render testing if needed |
| Percentage widths don't work well in small terminals | Medium | Low | Use useScreenSize for adaptive thresholds |
| Activity events hard to derive from polling diffs | Medium | Medium | Keep simple: log step transitions observed between polls |

## Notes
- Navigation is explicitly out of scope (#12). Dashboard defaults to first panel active, first group selected. State management for selection will be added in #12.
- The `useStatusPoller` hook should reuse `readGroupStatus` from status-manager.ts to avoid duplicating validation logic.
- For activity events: compare previous poll result with current, emit events for any step changes detected.
- The `dashboard` CLI command is separate from `start` — it's a read-only view. A future integration could combine `start` + `dashboard` to show live orchestration progress.
