# Plan: TUI Dashboard — Navigation, Keybindings, Screen Modes

## Summary
Add keyboard navigation and screen mode cycling to the existing TUI Dashboard. Number keys 1-3 jump between sidebar panels, j/k and arrow keys navigate within panels, `+` cycles screen layouts (normal/half/full), `d` toggles dependency graph, `l` toggles log tail, `q` triggers shutdown. Footer hints update contextually.

## User Story
As a developer monitoring the orchestrator,
I want keyboard shortcuts to navigate panels and toggle views,
So that I can quickly inspect different PR groups, issues, and logs without leaving the dashboard.

## Problem -> Solution
Static dashboard with hardcoded `activePanel=0`, `selectedGroupIndex=0`, `selectedIssueIndex=0` -> Fully interactive dashboard with keyboard-driven navigation, selection state, screen mode cycling, and overlay panels.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (GitHub issue #12)
- **PRD Phase**: N/A
- **Estimated Files**: 10

---

## UX Design

### Before
```
Static layout — no keyboard interaction.
activePanel always 0, selectedGroupIndex always 0.
Footer shows hints but they do nothing.
```

### After
```
┌─ PR Groups [1] ────────┬─ PR 5: TUI Dashboard ──────────────────────┐
│ ⚙ PR 5: TUI Dashboard  │  Branch: feat/tui-dashboard                │
│ · PR 6: Resilience      │  Progress: 1/4 issues                      │
├─ Issues [2] ────────────┤  Issues:                                    │
│ ⚙ #11 Layout  [coding]  │  ⚙ #11 [coding]  · #12  · #13  · #14      │
│ · #12 Navigation        │                                             │
├─ Activity [3] ──────────┤                                             │
│ 13:42 #11 coding        │                                             │
└─────────────────────────┴─────────────────────────────────────────────┘
 1-3 panel | j/k select | + layout | d deps | l logs | q quit
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Panel focus | Hardcoded 0 | 1/2/3 keys jump panels | Active panel border green |
| Item selection | Hardcoded 0 | j/k or arrows navigate | Wraps at boundaries |
| Screen layout | Fixed 33/67 | + cycles normal/half/full | Full hides non-focused |
| Dependency graph | N/A | d toggles graph overlay in main view | ASCII visualization |
| Log tail | N/A | l toggles log tail in main view | Reads from .orchestrator/logs/ |
| Quit | N/A | q triggers shutdown | Process exit |
| Footer | Static hints | Context-sensitive per active panel | Updates dynamically |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/tui/Dashboard.tsx` | all | Root component — will add useInput and state here |
| P0 | `src/tui/Sidebar.tsx` | all | Receives activePanel and selectedIndex props |
| P0 | `src/tui/Footer.tsx` | all | Rewrite to accept dynamic hints |
| P0 | `src/tui/Panel.tsx` | all | Panel wrapper — unchanged but referenced |
| P1 | `src/tui/PRGroupsPanel.tsx` | all | Selection rendering pattern |
| P1 | `src/tui/IssuesPanel.tsx` | all | Item count needed for wrap logic |
| P1 | `src/tui/MainView.tsx` | all | Will conditionally render graph/logs overlays |
| P1 | `src/tui/use-status-poller.ts` | all | groups/activity data source |
| P1 | `src/tui/types.ts` | all | Extend with new types |
| P2 | `src/graph.ts` | all | DependencyGraph for d toggle |
| P2 | `src/tui/Dashboard.test.tsx` | all | Test patterns to mirror |
| P2 | `src/types.ts` | 83-94 | GroupStatus type |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Ink useInput | vadimdemedes/ink readme | `useInput((input, key) => {})` — input is char, key has `.upArrow`/`.downArrow`/`.return`/`.escape` booleans |
| Ink useApp | vadimdemedes/ink readme | `const { exit } = useApp()` — for q quit |
| fullscreen-ink | daniguardiola/fullscreen-ink | `useScreenSize()` returns `{ width, height }` |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/tui/Dashboard.tsx:1-7
// PascalCase components, camelCase hooks/functions, kebab-case files
import { useScreenSize } from 'fullscreen-ink';
import { Footer } from './Footer.js';
import { useStatusPoller } from './use-status-poller.js';
```

### COMPONENT_PROPS
```typescript
// SOURCE: src/tui/Sidebar.tsx:9-15
// readonly props, explicit interface, no default exports
interface SidebarProps {
  readonly groups: readonly GroupStatus[];
  readonly activePanel: number;
  readonly selectedGroupIndex: number;
  readonly selectedIssueIndex: number;
  readonly activity: readonly ActivityEvent[];
}
```

### PANEL_SELECTION_RENDERING
```typescript
// SOURCE: src/tui/PRGroupsPanel.tsx:37-44
// Blue background when selected+active, bold when selected+inactive
<Text
  backgroundColor={selected && active ? 'blue' : undefined}
  bold={selected && !active}
>
  {icon} {group.pr_group} ({done}/{total})
</Text>
```

### EMPTY_STATE
```typescript
// SOURCE: src/tui/PRGroupsPanel.tsx:14-22
// Consistent empty state pattern
if (groups.length === 0) {
  return (
    <Panel title="PR Groups" active={active}>
      <Box marginLeft={1}>
        <Text dimColor>Waiting for work...</Text>
      </Box>
    </Panel>
  );
}
```

### HOOK_PATTERN
```typescript
// SOURCE: src/tui/use-status-poller.ts:48-79
// Custom hooks: use- prefix, return readonly interface, useEffect for side effects
export function useStatusPoller(baseDir: string, intervalMs = 2000): StatusPollerResult {
  const [groups, setGroups] = useState<readonly GroupStatus[]>([]);
  // ...
  return { groups, activity };
}
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/tui/Dashboard.test.tsx:1-15
// ink-testing-library render, React.createElement (no JSX in tests), lastFrame() assertions
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
// ...
const { lastFrame } = render(React.createElement(Component, props));
expect(lastFrame()).toContain('expected text');
```

### FOOTER_HINTS
```typescript
// SOURCE: src/tui/Footer.tsx:4-9
// Hints as readonly tuple array
const HINTS: readonly (readonly [string, string])[] = [
  ['q', 'quit'],
  ['↑↓', 'select'],
  ['←→', 'panel'],
  ['enter', 'details'],
];
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/tui/types.ts` | UPDATE | Add ScreenMode type, overlay types |
| `src/tui/use-keyboard.ts` | CREATE | Custom hook encapsulating useInput + all navigation state |
| `src/tui/DependencyGraphView.tsx` | CREATE | ASCII dependency graph overlay |
| `src/tui/LogTailView.tsx` | CREATE | Log tail overlay reading from .orchestrator/logs/ |
| `src/tui/Dashboard.tsx` | UPDATE | Wire useKeyboard hook, pass state down, conditional overlays |
| `src/tui/Sidebar.tsx` | UPDATE | No changes needed — already accepts props |
| `src/tui/Footer.tsx` | UPDATE | Accept hints as prop instead of hardcoded |
| `src/tui/MainView.tsx` | UPDATE | Accept overlay mode prop for graph/logs |
| `src/tui/use-keyboard.test.ts` | CREATE | Unit tests for navigation state logic |
| `src/tui/Dashboard.test.tsx` | UPDATE | Add interaction tests for keybindings |

## NOT Building

- Interactive takeover (Ink unmount/remount) — that's #13
- Notification service — that's #14
- Actual shutdown orchestration logic — just process exit for now
- Scrolling within panels (items exceeding panel height)
- Mouse input support

---

## Step-by-Step Tasks

### Task 1: Add types for screen mode and overlays
- **ACTION**: Extend `src/tui/types.ts` with new types
- **IMPLEMENT**:
  ```typescript
  export type ScreenMode = 'normal' | 'half' | 'full';
  export type OverlayMode = 'none' | 'deps' | 'logs';
  ```
- **MIRROR**: Existing type pattern in `src/tui/types.ts` — simple type aliases, readonly
- **IMPORTS**: None
- **VALIDATE**: `pnpm typecheck`

### Task 2: Create `use-keyboard` hook with navigation state
- **ACTION**: Create `src/tui/use-keyboard.ts` — custom hook managing all keyboard state
- **IMPLEMENT**:
  ```typescript
  import { useApp, useInput } from 'ink';
  import { useState } from 'react';
  import type { OverlayMode, ScreenMode } from './types.js';

  interface UseKeyboardOptions {
    readonly groupCount: number;
    readonly issueCount: number;
  }

  interface KeyboardState {
    readonly activePanel: number;       // 0=groups, 1=issues, 2=activity
    readonly selectedGroupIndex: number;
    readonly selectedIssueIndex: number;
    readonly screenMode: ScreenMode;
    readonly overlay: OverlayMode;
  }

  export function useKeyboard(options: UseKeyboardOptions): KeyboardState {
    const { exit } = useApp();
    const [activePanel, setActivePanel] = useState(0);
    const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
    const [selectedIssueIndex, setSelectedIssueIndex] = useState(0);
    const [screenMode, setScreenMode] = useState<ScreenMode>('normal');
    const [overlay, setOverlay] = useState<OverlayMode>('none');

    useInput((input, key) => {
      // Panel jumping: 1, 2, 3
      if (input === '1') { setActivePanel(0); return; }
      if (input === '2') { setActivePanel(1); return; }
      if (input === '3') { setActivePanel(2); return; }

      // Navigation within active panel: j/k or up/down
      if (input === 'j' || key.downArrow) {
        navigateDown();
        return;
      }
      if (input === 'k' || key.upArrow) {
        navigateUp();
        return;
      }

      // Screen mode cycling: +
      if (input === '+') {
        setScreenMode((prev) => {
          const modes: readonly ScreenMode[] = ['normal', 'half', 'full'];
          const idx = modes.indexOf(prev);
          return modes[(idx + 1) % modes.length];
        });
        return;
      }

      // Overlay toggles
      if (input === 'd') {
        setOverlay((prev) => prev === 'deps' ? 'none' : 'deps');
        return;
      }
      if (input === 'l') {
        setOverlay((prev) => prev === 'logs' ? 'none' : 'logs');
        return;
      }

      // Quit
      if (input === 'q') {
        exit();
        return;
      }
    });

    function navigateDown(): void {
      if (activePanel === 0) {
        setSelectedGroupIndex((prev) =>
          options.groupCount === 0 ? 0 : (prev + 1) % options.groupCount
        );
      } else if (activePanel === 1) {
        setSelectedIssueIndex((prev) =>
          options.issueCount === 0 ? 0 : (prev + 1) % options.issueCount
        );
      }
      // Activity panel: no selection navigation (read-only log)
    }

    function navigateUp(): void {
      if (activePanel === 0) {
        setSelectedGroupIndex((prev) =>
          options.groupCount === 0 ? 0 : (prev - 1 + options.groupCount) % options.groupCount
        );
      } else if (activePanel === 1) {
        setSelectedIssueIndex((prev) =>
          options.issueCount === 0 ? 0 : (prev - 1 + options.issueCount) % options.issueCount
        );
      }
    }

    return { activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay };
  }
  ```
- **MIRROR**: `use-status-poller.ts` hook pattern — named export, return readonly interface
- **IMPORTS**: `ink` (useInput, useApp), `react` (useState), `./types.js`
- **GOTCHA**: `useInput` callback closes over state — navigateDown/navigateUp use functional updates to avoid stale closures. `options.groupCount` changes when poller updates — hook re-registers automatically.
- **GOTCHA**: When `selectedGroupIndex` changes, reset `selectedIssueIndex` to 0 (new group has different issues). Add a `useEffect` for this.
- **VALIDATE**: `pnpm typecheck` + unit tests in Task 7

### Task 3: Create DependencyGraphView component
- **ACTION**: Create `src/tui/DependencyGraphView.tsx` — ASCII visualization of cross-group dependencies
- **IMPLEMENT**:
  ```typescript
  import { Box, Text } from 'ink';
  import type { ReactNode } from 'react';
  import type { GroupStatus } from '../types.js';
  import { Panel } from './Panel.js';
  import { getGroupIcon } from './status-icon.js';

  interface DependencyGraphViewProps {
    readonly groups: readonly GroupStatus[];
  }

  export function DependencyGraphView({ groups }: DependencyGraphViewProps): ReactNode {
    if (groups.length === 0) {
      return (
        <Panel title="Dependency Graph" active={false}>
          <Box marginLeft={1}>
            <Text dimColor>No groups</Text>
          </Box>
        </Panel>
      );
    }

    // Render simple ASCII tree: each group with its icon
    // Full graph from parser data not available in TUI context,
    // so show status-based visualization of group ordering
    return (
      <Panel title="Dependency Graph" active={false}>
        <Box flexDirection="column" marginLeft={1}>
          {groups.map((group, i) => {
            const icon = getGroupIcon(
              group.issues_completed.length,
              group.issues_remaining.length,
              group.step,
            );
            const connector = i < groups.length - 1 ? '├── ' : '└── ';
            const pipe = i < groups.length - 1 ? '│' : ' ';
            return (
              <Box key={group.pr_group} flexDirection="column">
                <Text>
                  {connector}{icon} {group.pr_group}
                </Text>
                {i < groups.length - 1 && <Text dimColor>{pipe}</Text>}
              </Box>
            );
          })}
        </Box>
      </Panel>
    );
  }
  ```
- **MIRROR**: `MainView.tsx` component pattern — Panel wrapper, empty state, getGroupIcon usage
- **IMPORTS**: `ink`, `react`, `../types.js`, `./Panel.js`, `./status-icon.js`
- **GOTCHA**: Keep it simple — no need to reconstruct full dependency graph from status files. Groups are polled in order. Full graph rendering can be enhanced later.
- **VALIDATE**: `pnpm typecheck` + render test

### Task 4: Create LogTailView component
- **ACTION**: Create `src/tui/LogTailView.tsx` — log tail panel for selected PR group
- **IMPLEMENT**:
  ```typescript
  import * as fs from 'node:fs';
  import * as path from 'node:path';
  import { Box, Text } from 'ink';
  import type { ReactNode } from 'react';
  import { Panel } from './Panel.js';

  interface LogTailViewProps {
    readonly groupSlug: string | null;
    readonly baseDir: string;
  }

  const MAX_LINES = 20;

  export function LogTailView({ groupSlug, baseDir }: LogTailViewProps): ReactNode {
    if (!groupSlug) {
      return (
        <Panel title="Logs" active={false}>
          <Box marginLeft={1}>
            <Text dimColor>No group selected</Text>
          </Box>
        </Panel>
      );
    }

    const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);
    const lines = readLatestLogLines(logDir, MAX_LINES);

    return (
      <Panel title={`Logs (${groupSlug})`} active={false}>
        <Box flexDirection="column" marginLeft={1}>
          {lines.length === 0 ? (
            <Text dimColor>No logs</Text>
          ) : (
            lines.map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))
          )}
        </Box>
      </Panel>
    );
  }

  function readLatestLogLines(logDir: string, maxLines: number): readonly string[] {
    if (!fs.existsSync(logDir)) return [];

    const files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse();

    if (files.length === 0) return [];

    const latestLog = path.join(logDir, files[0]);
    try {
      const content = fs.readFileSync(latestLog, 'utf-8');
      return content.split('\n').filter(Boolean).slice(-maxLines);
    } catch {
      return [];
    }
  }
  ```
- **MIRROR**: `use-status-poller.ts` for fs pattern (existsSync, readdirSync, readFileSync)
- **IMPORTS**: `node:fs`, `node:path`, `ink`, `react`, `./Panel.js`
- **GOTCHA**: Log files read synchronously on each render — acceptable since poller drives re-renders at 1-3s interval. Don't add separate polling for logs.
- **GOTCHA**: Use `key={i}` for log lines since content may repeat. Acceptable for display-only list.
- **VALIDATE**: `pnpm typecheck` + render test

### Task 5: Update Footer to accept dynamic hints
- **ACTION**: Update `src/tui/Footer.tsx` to accept hints as prop
- **IMPLEMENT**:
  ```typescript
  import { Box, Text } from 'ink';
  import type { ReactNode } from 'react';
  import type { OverlayMode, ScreenMode } from './types.js';

  interface FooterProps {
    readonly activePanel: number;
    readonly screenMode: ScreenMode;
    readonly overlay: OverlayMode;
  }

  function getHints(activePanel: number, screenMode: ScreenMode, overlay: OverlayMode): readonly (readonly [string, string])[] {
    const hints: (readonly [string, string])[] = [
      ['1-3', 'panel'],
      ['j/k', 'select'],
      ['+', `layout:${screenMode}`],
      ['d', overlay === 'deps' ? 'deps:on' : 'deps'],
      ['l', overlay === 'logs' ? 'logs:on' : 'logs'],
      ['q', 'quit'],
    ];
    return hints;
  }

  export function Footer({ activePanel, screenMode, overlay }: FooterProps): ReactNode {
    const hints = getHints(activePanel, screenMode, overlay);
    return (
      <Box>
        {hints.map(([key, label], i) => (
          <Box key={key} marginRight={1}>
            {i > 0 && <Text dimColor> | </Text>}
            <Text bold>{key}</Text>
            <Text dimColor> {label}</Text>
          </Box>
        ))}
      </Box>
    );
  }
  ```
- **MIRROR**: Existing Footer pattern — tuple array, map with separator
- **IMPORTS**: `ink`, `react`, `./types.js`
- **GOTCHA**: Breaking change to Footer interface. Update all call sites (Dashboard.tsx) and tests.
- **VALIDATE**: `pnpm typecheck` + existing Footer test updated

### Task 6: Update Dashboard to wire everything together
- **ACTION**: Update `src/tui/Dashboard.tsx` — add useKeyboard, pass state down, render overlays
- **IMPLEMENT**:
  ```typescript
  import { useScreenSize } from 'fullscreen-ink';
  import { Box } from 'ink';
  import type { ReactNode } from 'react';
  import { DependencyGraphView } from './DependencyGraphView.js';
  import { Footer } from './Footer.js';
  import { LogTailView } from './LogTailView.js';
  import { MainView } from './MainView.js';
  import { Sidebar } from './Sidebar.js';
  import { useKeyboard } from './use-keyboard.js';
  import { useStatusPoller } from './use-status-poller.js';

  interface DashboardProps {
    readonly baseDir: string;
    readonly pollInterval?: number;
  }

  export function Dashboard({ baseDir, pollInterval = 2000 }: DashboardProps): ReactNode {
    const { width, height } = useScreenSize();
    const { groups, activity } = useStatusPoller(baseDir, pollInterval);

    const selectedGroup = groups[selectedGroupIndex] ?? null;
    const issueCount = selectedGroup
      ? selectedGroup.issues_completed.length + selectedGroup.issues_remaining.length
      : 0;

    const { activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay } =
      useKeyboard({ groupCount: groups.length, issueCount });

    // Screen mode widths
    const sidebarWidth = screenMode === 'full' ? '0%' :
                         screenMode === 'half' ? '50%' : '33%';
    const mainWidth = screenMode === 'full' ? '100%' :
                      screenMode === 'half' ? '50%' : '67%';

    // Main view content based on overlay
    const mainContent = overlay === 'deps'
      ? <DependencyGraphView groups={groups} />
      : overlay === 'logs'
        ? <LogTailView groupSlug={selectedGroup?.pr_group ?? null} baseDir={baseDir} />
        : <MainView group={selectedGroup} />;

    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box flexDirection="row" flexGrow={1}>
          {screenMode !== 'full' && (
            <Box width={sidebarWidth}>
              <Sidebar
                groups={groups}
                activePanel={activePanel}
                selectedGroupIndex={selectedGroupIndex}
                selectedIssueIndex={selectedIssueIndex}
                activity={activity}
              />
            </Box>
          )}
          <Box width={mainWidth}>
            {mainContent}
          </Box>
        </Box>
        <Footer activePanel={activePanel} screenMode={screenMode} overlay={overlay} />
      </Box>
    );
  }
  ```
- **MIRROR**: Existing Dashboard.tsx structure — same import order, same JSX layout
- **IMPORTS**: All existing + `./use-keyboard.js`, `./DependencyGraphView.js`, `./LogTailView.js`
- **GOTCHA**: `selectedGroupIndex` used before `useKeyboard` call for `issueCount` — reorder: call useKeyboard first, then derive selectedGroup. Or compute issueCount from previous render's groups (stale by one tick, acceptable).
- **GOTCHA**: Actually, must call `useKeyboard` unconditionally (React hooks rule). Compute `issueCount` from `groups` and `selectedGroupIndex` after the hook. The hook returns `selectedGroupIndex` which may reference a stale count — add clamping inside the hook's `navigateDown`/`navigateUp` or add a `useEffect` to clamp when counts change.
- **VALIDATE**: `pnpm typecheck` + `pnpm test`

### Task 7: Write unit tests for use-keyboard hook
- **ACTION**: Create `src/tui/use-keyboard.test.ts`
- **IMPLEMENT**: Test navigation state transitions using `ink-testing-library`. Create a thin wrapper component that renders keyboard state as text, then use `stdin.write()` to simulate keypresses.
  ```typescript
  import { Text } from 'ink';
  import { render } from 'ink-testing-library';
  import React, { type ReactNode } from 'react';
  import { describe, expect, it } from 'vitest';
  import { useKeyboard } from './use-keyboard.js';

  function TestHarness({ groupCount, issueCount }: { groupCount: number; issueCount: number }): ReactNode {
    const state = useKeyboard({ groupCount, issueCount });
    return React.createElement(Text, null,
      `panel:${state.activePanel} group:${state.selectedGroupIndex} issue:${state.selectedIssueIndex} mode:${state.screenMode} overlay:${state.overlay}`
    );
  }

  describe('useKeyboard', () => {
    it('starts with default state', () => {
      const { lastFrame } = render(React.createElement(TestHarness, { groupCount: 3, issueCount: 2 }));
      expect(lastFrame()).toContain('panel:0');
      expect(lastFrame()).toContain('group:0');
      expect(lastFrame()).toContain('mode:normal');
      expect(lastFrame()).toContain('overlay:none');
    });

    it('switches panels with 1/2/3', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 3, issueCount: 2 }));
      stdin.write('2');
      expect(lastFrame()).toContain('panel:1');
      stdin.write('3');
      expect(lastFrame()).toContain('panel:2');
      stdin.write('1');
      expect(lastFrame()).toContain('panel:0');
    });

    it('navigates groups with j/k', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 3, issueCount: 2 }));
      stdin.write('j');
      expect(lastFrame()).toContain('group:1');
      stdin.write('j');
      expect(lastFrame()).toContain('group:2');
      // Wraps
      stdin.write('j');
      expect(lastFrame()).toContain('group:0');
      // Up wraps
      stdin.write('k');
      expect(lastFrame()).toContain('group:2');
    });

    it('navigates issues in panel 1', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 3, issueCount: 4 }));
      stdin.write('2'); // Switch to issues panel
      stdin.write('j');
      expect(lastFrame()).toContain('issue:1');
      stdin.write('j');
      expect(lastFrame()).toContain('issue:2');
    });

    it('cycles screen modes with +', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 1, issueCount: 1 }));
      stdin.write('+');
      expect(lastFrame()).toContain('mode:half');
      stdin.write('+');
      expect(lastFrame()).toContain('mode:full');
      stdin.write('+');
      expect(lastFrame()).toContain('mode:normal');
    });

    it('toggles dependency graph overlay with d', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 1, issueCount: 1 }));
      stdin.write('d');
      expect(lastFrame()).toContain('overlay:deps');
      stdin.write('d');
      expect(lastFrame()).toContain('overlay:none');
    });

    it('toggles log overlay with l', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 1, issueCount: 1 }));
      stdin.write('l');
      expect(lastFrame()).toContain('overlay:logs');
      stdin.write('l');
      expect(lastFrame()).toContain('overlay:none');
    });

    it('d and l are mutually exclusive', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 1, issueCount: 1 }));
      stdin.write('d');
      expect(lastFrame()).toContain('overlay:deps');
      stdin.write('l');
      expect(lastFrame()).toContain('overlay:logs');
      stdin.write('d');
      expect(lastFrame()).toContain('overlay:deps');
    });

    it('does not navigate when group count is 0', () => {
      const { lastFrame, stdin } = render(React.createElement(TestHarness, { groupCount: 0, issueCount: 0 }));
      stdin.write('j');
      expect(lastFrame()).toContain('group:0');
    });
  });
  ```
- **MIRROR**: `Dashboard.test.tsx` pattern — `ink-testing-library`, `React.createElement`, vitest
- **IMPORTS**: `ink`, `ink-testing-library`, `react`, `vitest`
- **GOTCHA**: `stdin.write` sends raw characters. Arrow keys need escape sequences: `\x1B[A` (up), `\x1B[B` (down). Test j/k first (simpler), add arrow key tests if needed.
- **VALIDATE**: `pnpm test -- --run src/tui/use-keyboard.test.ts`

### Task 8: Update Dashboard.test.tsx with interaction tests
- **ACTION**: Update `src/tui/Dashboard.test.tsx` — add tests for new overlay components, updated Footer
- **IMPLEMENT**: Add test cases for:
  - DependencyGraphView empty state and with groups
  - LogTailView empty state and with no group
  - Footer with dynamic hints (verify layout:normal, deps, logs labels)
  - Update existing Footer test to pass new props
- **MIRROR**: Existing test structure in Dashboard.test.tsx
- **GOTCHA**: Existing Footer test `render(React.createElement(Footer))` will break — needs props now. Fix immediately.
- **VALIDATE**: `pnpm test -- --run`

### Task 9: Clamp indices when data changes
- **ACTION**: Add `useEffect` in `use-keyboard.ts` to reset `selectedIssueIndex` when `selectedGroupIndex` changes, and clamp indices when counts shrink
- **IMPLEMENT**:
  ```typescript
  // Inside useKeyboard, after state declarations:
  useEffect(() => {
    setSelectedIssueIndex(0);
  }, [selectedGroupIndex]);

  useEffect(() => {
    if (options.groupCount > 0 && selectedGroupIndex >= options.groupCount) {
      setSelectedGroupIndex(options.groupCount - 1);
    }
  }, [options.groupCount, selectedGroupIndex]);

  useEffect(() => {
    if (options.issueCount > 0 && selectedIssueIndex >= options.issueCount) {
      setSelectedIssueIndex(options.issueCount - 1);
    }
  }, [options.issueCount, selectedIssueIndex]);
  ```
- **MIRROR**: React hooks pattern
- **IMPORTS**: `useEffect` from react
- **GOTCHA**: These effects run after render — one frame of stale index is acceptable. Panels already handle out-of-bounds gracefully (no crash).
- **VALIDATE**: `pnpm test`

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Default keyboard state | No input | panel:0, group:0, mode:normal, overlay:none | No |
| Panel switch 1/2/3 | Key '2' | activePanel=1 | No |
| j navigates down in groups | Key 'j' | selectedGroupIndex increments | No |
| k navigates up in groups | Key 'k' from 0 | Wraps to last | Yes |
| j wraps at boundary | Key 'j' at last | Wraps to 0 | Yes |
| + cycles screen modes | Key '+' x3 | normal->half->full->normal | No |
| d toggles deps overlay | Key 'd' x2 | deps->none | No |
| l toggles logs overlay | Key 'l' | overlay=logs | No |
| d after l | Key 'd' then 'l' | overlay switches to logs | Yes |
| Empty groups navigation | j with 0 groups | Index stays 0 | Yes |
| DependencyGraphView empty | No groups | "No groups" text | Yes |
| DependencyGraphView groups | 3 groups | All group names + icons | No |
| LogTailView no group | null slug | "No group selected" | Yes |
| Footer dynamic hints | Various states | Correct hint labels | No |

### Edge Cases Checklist
- [x] Empty input (no groups, no issues)
- [x] Single item lists (group count = 1)
- [x] Wrap at boundaries (top and bottom)
- [x] Index clamping when data shrinks
- [x] Issue index reset on group change
- [x] Zero-count navigation (no crash)
- [ ] Concurrent keyboard input (React batches — safe)

---

## Validation Commands

### Static Analysis
```bash
pnpm check
```
EXPECT: Zero lint errors

### Type Check
```bash
pnpm typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm test -- --run
```
EXPECT: All tests pass including new ones

### Build
```bash
pnpm build
```
EXPECT: Clean build, no warnings

### Manual Validation
- [ ] Run `pnpm dev -- dashboard` with status files present
- [ ] Press 1, 2, 3 — verify panel focus changes (green border)
- [ ] Press j/k — verify item selection moves within active panel
- [ ] Press + — verify layout cycles: normal (33/67) -> half (50/50) -> full (100%)
- [ ] Press d — verify dependency graph appears in main view
- [ ] Press l — verify log tail appears in main view
- [ ] Press q — verify process exits
- [ ] Verify footer hints update with current state

---

## Acceptance Criteria
- [ ] Keys `1`, `2`, `3` jump to PR Groups, Issues, Activity panels respectively
- [ ] `j`/`k` and arrow keys navigate items within active panel
- [ ] Selection wraps at list boundaries
- [ ] `+` cycles screen modes: normal -> half -> full -> normal
- [ ] In full mode, focused panel takes entire width; non-focused panels hidden
- [ ] `d` toggles dependency graph panel (ASCII visualization)
- [ ] `l` toggles log tail panel (reads from `.orchestrator/logs/<group>/<issue>.log`)
- [ ] `q` triggers shutdown flow
- [ ] Footer bar updates with relevant keybindings for current context
- [ ] Selecting a PR group in panel 1 updates panels 2 and 3 and main view
- [ ] Interaction tests verify keybinding behavior

## Completion Checklist
- [ ] Code follows discovered patterns (Panel wrapper, readonly props, hook pattern)
- [ ] Error handling matches codebase style (empty state graceful, fs try/catch)
- [ ] Tests follow test patterns (ink-testing-library, React.createElement, vitest)
- [ ] No hardcoded values (MAX_LINES constant, modes array)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| stdin.write in tests doesn't trigger useInput | Low | High | Ink testing library officially supports this pattern; verified in docs |
| Arrow key escape sequences differ across terminals | Medium | Low | Primary navigation is j/k; arrow keys are secondary |
| Log file reading blocks event loop | Low | Medium | Sync reads at 2s poll interval; files are small |
| Screen mode 'full' hides sidebar context | Low | Low | User can cycle back; footer shows current mode |

## Notes
- The `useKeyboard` hook encapsulates all keyboard state — Dashboard stays thin as a layout shell
- `d` and `l` overlays replace the main view content (not sidebar) — this matches the issue spec
- Activity panel (panel 3) has no selectable items — j/k are no-ops when active
- The hook returns immutable state — Dashboard re-renders on any state change via React's normal flow
- `selectedGroupIndex` changes should cascade: Sidebar gets new index, IssuesPanel gets new group, MainView gets new group detail
