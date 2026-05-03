# Plan: Interactive Takeover (Ink unmount/remount + neovim)

## Summary

Add interactive takeover mode to the TUI dashboard. `Enter` on a PR group unmounts Ink, spawns an interactive shell in the worktree directory. `v` opens neovim at the worktree path. On exit, Ink remounts with dashboard state preserved.

## User Story

As a developer using the orchestrator TUI, I want to drop into a worktree's shell or editor directly from the dashboard, so that I can interact with code without leaving the orchestrator.

## Problem → Solution

Dashboard is view-only, no way to interact with worktrees → Press `Enter`/`v` to takeover terminal, return to dashboard on exit.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A (Issue #13)
- **Estimated Files**: 5 new/modified

---

## UX Design

### Before

```
┌─────────────────────────────────────────┐
│  PR Groups │ Issues │ Activity   │ Main │
│  > pr-5    │ #11    │ 13:42 ...  │ ...  │
│    pr-6    │ #12    │            │      │
├─────────────────────────────────────────┤
│ 1-3 panel | j/k group | + layout | q   │
└─────────────────────────────────────────┘
(No way to interact with worktree)
```

### After

```
┌─────────────────────────────────────────┐
│  PR Groups │ Issues │ Activity   │ Main │
│  > pr-5    │ #11    │ 13:42 ...  │ ...  │
├─────────────────────────────────────────┤
│ ... | ↵ shell | v nvim | ...           │
└─────────────────────────────────────────┘

User presses Enter:
  → Dashboard disappears (alternate buffer exit)
  → Shell prompt in /path/to/.orchestrator/worktrees/pr-5
  → User runs commands, exits with Ctrl+D
  → Dashboard reappears with same selection state
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `Enter` key | No action | Unmount → shell in worktree | Only when panel 0 (PR Groups) |
| `v` key | No action | Unmount → nvim at worktree | Only when panel 0 |
| Shell exit | N/A | Remount dashboard | State preserved |
| Missing worktree | N/A | Error flash, no unmount | Graceful handling |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/tui/launch.ts` | all | Entry point — must modify to support unmount/remount |
| P0 | `src/tui/use-keyboard.ts` | all | Keyboard hook — add Enter/v bindings |
| P0 | `node_modules/fullscreen-ink/dist/esm/withFullScreen.js` | all | API: `{ instance, start(), waitUntilExit() }` |
| P1 | `src/tui/Dashboard.tsx` | all | Dashboard component — needs takeover callback prop |
| P1 | `src/worktree-manager.ts` | 29-40 | `getWorktreePath()` and `exists()` for path resolution |
| P1 | `src/tui/Footer.tsx` | all | Add Enter/v hints |
| P2 | `src/tui/use-keyboard.test.tsx` | all | Test patterns to follow |
| P2 | `src/tui/types.ts` | all | Type definitions to extend |

---

## Patterns to Mirror

### NAMING_CONVENTION
```typescript
// SOURCE: src/tui/use-keyboard.ts:1-4
import { useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { GroupStatus } from '../types.js';
import type { OverlayMode, ScreenMode } from './types.js';
```

### ERROR_HANDLING
```typescript
// SOURCE: src/worktree-manager.ts:8-15
function getGitErrorMessage(err: unknown): string {
	if (err && typeof err === 'object' && 'stderr' in err) {
		const stderr = (err as { stderr: Buffer | string }).stderr;
		const text = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr);
		if (text.trim()) return text.trim();
	}
	return err instanceof Error ? err.message : String(err);
}
```

### SPAWN_PATTERN
```typescript
// SOURCE: src/worker-manager.ts (adapted for interactive)
import { spawn } from 'node:child_process';

const proc = spawn(shell, [], {
	cwd: worktreePath,
	stdio: 'inherit',
	env: process.env,
});
proc.on('close', () => { /* remount */ });
```

### FULLSCREEN_INK_API
```typescript
// SOURCE: node_modules/fullscreen-ink/dist/esm/withFullScreen.js
// Returns: { instance: Instance, start: () => Promise<void>, waitUntilExit: () => Promise<void> }
// instance has: unmount(), rerender(), waitUntilExit()
// Alternate buffer: \x1b[?1049h (enter), \x1b[?1049l (exit)
```

### TEST_STRUCTURE
```typescript
// SOURCE: src/tui/use-keyboard.test.tsx:31-35
async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
	await act(async () => {
		stdin.write(key);
	});
}
```

### KEYBOARD_BINDING_PATTERN
```typescript
// SOURCE: src/tui/use-keyboard.ts:72-76
useInput((input, key) => {
	if (input === '1') {
		setActivePanel(0);
		return;
	}
	// ...
});
```

---

## Architecture

### Approach

The takeover lifecycle must happen **outside React** since Ink unmounts during takeover. The pattern:

1. `launch.ts` becomes a loop that manages the app lifecycle
2. Dashboard communicates takeover intent via a callback (not state)
3. The launch loop: unmount Ink → exit alt buffer → spawn process → wait → re-enter alt buffer → remount Ink

### Key Insight

`withFullScreen` manages the alternate screen buffer. During takeover:
- Must exit alternate buffer so user sees normal terminal
- Must re-enter alternate buffer when remounting

The `withFullScreen` source shows it uses `\x1b[?1049h` (enter) and `\x1b[?1049l` (exit). We can replicate this directly.

### State Preservation

Dashboard state (activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay) is derived from:
- `useStatusPoller` — re-polls on mount (stateless, file-based)
- `useKeyboard` — local state, lost on unmount

For state preservation across remount, pass initial state as props to Dashboard. The launch loop stores the last known state before unmount.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/tui/takeover.ts` | CREATE | Core takeover logic: unmount, spawn, remount |
| `src/tui/launch.ts` | UPDATE | Refactor to support unmount/remount cycle |
| `src/tui/use-keyboard.ts` | UPDATE | Add Enter/v bindings, takeover callback |
| `src/tui/Dashboard.tsx` | UPDATE | Accept onTakeover callback + initial state props |
| `src/tui/Footer.tsx` | UPDATE | Add Enter/v hints |
| `src/tui/types.ts` | UPDATE | Add TakeoverRequest type |
| `src/tui/takeover.test.ts` | CREATE | Unit tests for takeover module |
| `src/tui/use-keyboard.test.tsx` | UPDATE | Tests for Enter/v keybindings |

## NOT Building

- Piping stdin to running `claude -p` process (Model B, rejected per ADR 001)
- Pausing/resuming worker agents during takeover
- Custom shell configuration (always uses `$SHELL`)
- Tmux/screen integration
- Multiple simultaneous takeovers

---

## Step-by-Step Tasks

### Task 1: Add TakeoverRequest type

- **ACTION**: Add types to `src/tui/types.ts`
- **IMPLEMENT**:
  ```typescript
  export type TakeoverMode = 'shell' | 'nvim';

  export interface TakeoverRequest {
    readonly mode: TakeoverMode;
    readonly worktreePath: string;
    readonly branch: string;
  }

  export interface DashboardState {
    readonly activePanel: number;
    readonly selectedGroupIndex: number;
    readonly selectedIssueIndex: number;
    readonly screenMode: ScreenMode;
    readonly overlay: OverlayMode;
  }
  ```
- **MIRROR**: Existing readonly interface pattern in `src/types.ts`
- **IMPORTS**: None new
- **VALIDATE**: `pnpm check` passes

### Task 2: Create takeover module

- **ACTION**: Create `src/tui/takeover.ts` with `spawnTakeover()` function
- **IMPLEMENT**:
  ```typescript
  import { spawn } from 'node:child_process';
  import type { TakeoverRequest } from './types.js';

  export function spawnTakeover(request: TakeoverRequest): Promise<number> {
    return new Promise((resolve, reject) => {
      const { mode, worktreePath } = request;

      let command: string;
      let args: string[];

      if (mode === 'shell') {
        command = process.env.SHELL ?? '/bin/sh';
        args = [];
      } else {
        command = 'nvim';
        args = [worktreePath];
      }

      const proc = spawn(command, args, {
        cwd: worktreePath,
        stdio: 'inherit',
        env: process.env,
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${mode}: ${err.message}`));
      });

      proc.on('close', (code) => {
        resolve(code ?? 0);
      });
    });
  }
  ```
- **MIRROR**: spawn pattern from worker-manager, adapted for `stdio: 'inherit'`
- **IMPORTS**: `node:child_process`
- **GOTCHA**: Must handle `SHELL` env var being undefined (fallback `/bin/sh`)
- **VALIDATE**: `pnpm check` passes

### Task 3: Refactor launch.ts for unmount/remount cycle

- **ACTION**: Rewrite `src/tui/launch.ts` to support takeover loop
- **IMPLEMENT**:
  ```typescript
  import { render } from 'ink';
  import React from 'react';
  import { Dashboard } from './Dashboard.js';
  import { spawnTakeover } from './takeover.js';
  import type { DashboardState, TakeoverRequest } from './types.js';

  const ALT_BUFFER_ENTER = '\x1b[?1049h';
  const ALT_BUFFER_EXIT = '\x1b[?1049l';

  function write(content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      process.stdout.write(content, (err) => (err ? reject(err) : resolve()));
    });
  }

  export async function launchDashboard(baseDir = '.'): Promise<void> {
    let savedState: DashboardState | undefined;

    // Loop: mount → takeover → remount
    for (;;) {
      await write(ALT_BUFFER_ENTER);

      const takeoverPromise = new Promise<TakeoverRequest | null>((resolveTakeover) => {
        const onTakeover = (request: TakeoverRequest, state: DashboardState) => {
          savedState = state;
          instance.unmount();
          resolveTakeover(request);
        };

        const onQuit = () => {
          instance.unmount();
          resolveTakeover(null);
        };

        const app = React.createElement(Dashboard, {
          baseDir,
          initialState: savedState,
          onTakeover,
          onQuit,
        });
        var instance = render(app);
      });

      const request = await takeoverPromise;

      await write(ALT_BUFFER_EXIT);

      if (!request) break; // quit

      await spawnTakeover(request);
      // Loop continues → remounts dashboard
    }
  }
  ```
- **MIRROR**: `withFullScreen` alternate buffer pattern
- **IMPORTS**: `ink`, `react`, local modules
- **GOTCHA**: Must exit alt buffer before spawning process so user sees normal terminal. `var instance` hoisting needed for closure access — alternatively use `let` outside and assign inside.
- **VALIDATE**: `pnpm check` passes, manual test with `pnpm dev`

### Task 4: Update useKeyboard for Enter/v bindings

- **ACTION**: Add `onTakeover` callback and Enter/v handling to `use-keyboard.ts`
- **IMPLEMENT**:
  Add to `UseKeyboardOptions`:
  ```typescript
  interface UseKeyboardOptions {
    readonly groups: readonly GroupStatus[];
    readonly baseDir: string;
    readonly onTakeover?: (request: TakeoverRequest, state: DashboardState) => void;
  }
  ```
  Add to `useInput` handler:
  ```typescript
  if (key.return && activePanel === 0) {
    const group = groups[selectedGroupIndex];
    if (!group) return;
    const worktreePath = getWorktreePath(group.branch, baseDir);
    if (!existsSync(worktreePath)) return; // TODO: show error
    onTakeover?.({ mode: 'shell', worktreePath, branch: group.branch }, currentState());
    return;
  }
  if (input === 'v' && activePanel === 0) {
    const group = groups[selectedGroupIndex];
    if (!group) return;
    const worktreePath = getWorktreePath(group.branch, baseDir);
    if (!existsSync(worktreePath)) return;
    onTakeover?.({ mode: 'nvim', worktreePath, branch: group.branch }, currentState());
    return;
  }
  ```
  Add `currentState()` helper that returns current `DashboardState`.
- **MIRROR**: Existing `useInput` pattern with early returns
- **IMPORTS**: `import { existsSync } from 'node:fs'`, `import { getWorktreePath } from '../worktree-manager.js'`
- **GOTCHA**: `key.return` is the Ink way to detect Enter. Only trigger when `activePanel === 0` (PR Groups panel).
- **VALIDATE**: `pnpm check` passes, existing tests still pass

### Task 5: Update Dashboard to accept takeover props

- **ACTION**: Add `onTakeover`, `onQuit`, and `initialState` props to Dashboard
- **IMPLEMENT**:
  ```typescript
  interface DashboardProps {
    readonly baseDir: string;
    readonly pollInterval?: number;
    readonly initialState?: DashboardState;
    readonly onTakeover?: (request: TakeoverRequest, state: DashboardState) => void;
    readonly onQuit?: () => void;
  }
  ```
  Pass `onTakeover` and `baseDir` through to `useKeyboard`. Pass `onQuit` to replace `exit()` in useKeyboard.
  Pass `initialState` to `useKeyboard` for state restoration.
- **MIRROR**: Existing prop patterns in Dashboard
- **IMPORTS**: `DashboardState`, `TakeoverRequest` from `./types.js`
- **GOTCHA**: `initialState` must be used as the initial value in `useState` calls inside `useKeyboard`
- **VALIDATE**: Existing Dashboard tests still pass, `pnpm check` clean

### Task 6: Update useKeyboard to accept initialState

- **ACTION**: Use `initialState` as default values for useState hooks
- **IMPLEMENT**:
  ```typescript
  export function useKeyboard({ groups, baseDir, onTakeover, initialState }: UseKeyboardOptions): KeyboardState {
    const [activePanel, setActivePanel] = useState(initialState?.activePanel ?? 0);
    const [selectedGroupIndex, setSelectedGroupIndex] = useState(initialState?.selectedGroupIndex ?? 0);
    const [selectedIssueIndex, setSelectedIssueIndex] = useState(initialState?.selectedIssueIndex ?? 0);
    const [screenMode, setScreenMode] = useState<ScreenMode>(initialState?.screenMode ?? 'normal');
    const [overlay, setOverlay] = useState<OverlayMode>(initialState?.overlay ?? 'none');
    // ...
  }
  ```
  Replace `exit()` call on `q` with `onQuit?.()` if provided, else `exit()`.
- **MIRROR**: Existing useState pattern
- **VALIDATE**: All existing tests pass (they don't pass initialState, so defaults remain 0/normal/none)

### Task 7: Update Footer with Enter/v hints

- **ACTION**: Add `↵ shell` and `v nvim` hints when on PR Groups panel
- **IMPLEMENT**:
  In `getHints()`, when `activePanel === 0`:
  ```typescript
  const hints: (readonly [string, string])[] = [
    ['1-3', 'panel'],
    ...(jkLabel ? [['j/k', jkLabel] as const] : []),
    ...(activePanel === 0 ? [['↵', 'shell'] as const, ['v', 'nvim'] as const] : []),
    ['+', `layout:${NEXT_MODE[screenMode]}`],
    ['d', overlay === 'deps' ? 'deps:on' : 'deps'],
    ['l', overlay === 'logs' ? 'logs:on' : 'logs'],
    ['q', 'quit'],
  ];
  ```
- **MIRROR**: Existing hint tuple pattern
- **VALIDATE**: Footer test updated, `pnpm test` passes

### Task 8: Handle missing worktree gracefully

- **ACTION**: When Enter/v pressed but worktree doesn't exist, show flash message
- **IMPLEMENT**:
  Add `error` state to useKeyboard:
  ```typescript
  const [error, setError] = useState<string | null>(null);
  ```
  When worktree missing:
  ```typescript
  if (!existsSync(worktreePath)) {
    setError(`Worktree not found: ${group.branch}`);
    setTimeout(() => setError(null), 3000);
    return;
  }
  ```
  Return `error` from hook. Display in Dashboard above Footer.
- **MIRROR**: Existing state management pattern
- **GOTCHA**: Don't unmount on missing worktree
- **VALIDATE**: Add test for missing worktree case

### Task 9: Write tests for takeover module

- **ACTION**: Create `src/tui/takeover.test.ts`
- **IMPLEMENT**: Test `spawnTakeover` with mocked `child_process.spawn`:
  - Shell mode uses `$SHELL` env var
  - Falls back to `/bin/sh` when SHELL unset
  - Nvim mode passes worktreePath as arg
  - Sets cwd to worktreePath
  - Resolves with exit code on close
  - Rejects on spawn error
- **MIRROR**: Test structure from `use-keyboard.test.tsx`
- **IMPORTS**: `vitest`, mock `node:child_process`
- **VALIDATE**: `pnpm test` all green

### Task 10: Update keyboard tests for Enter/v

- **ACTION**: Add tests to `use-keyboard.test.tsx` for new bindings
- **IMPLEMENT**:
  - Test Enter calls onTakeover with mode='shell' when on panel 0
  - Test v calls onTakeover with mode='nvim' when on panel 0
  - Test Enter does nothing on panel 1/2
  - Test Enter does nothing when no groups
  - Test error state when worktree missing
- **MIRROR**: Existing press() helper pattern
- **GOTCHA**: Need to mock `existsSync` and `getWorktreePath` — use vi.mock
- **VALIDATE**: `pnpm test` all green

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| spawnTakeover shell | `{ mode: 'shell', worktreePath: '/tmp/wt' }` | Spawns $SHELL with cwd | No |
| spawnTakeover nvim | `{ mode: 'nvim', worktreePath: '/tmp/wt' }` | Spawns nvim with path arg | No |
| spawnTakeover no SHELL | Unset SHELL env | Falls back to /bin/sh | Yes |
| Enter on group | Press Enter, panel 0, groups exist | onTakeover called with shell mode | No |
| v on group | Press v, panel 0 | onTakeover called with nvim mode | No |
| Enter on panel 1 | Press Enter, panel 1 | No action | Yes |
| Enter no groups | Press Enter, groups=[] | No action | Yes |
| Enter missing worktree | Press Enter, worktree doesn't exist | Error message shown | Yes |

### Edge Cases Checklist

- [x] No groups selected (do nothing)
- [x] Worktree doesn't exist (error flash)
- [x] SHELL env var unset (fallback /bin/sh)
- [x] Process spawn error (reject promise)
- [x] State preserved across unmount/remount (initialState prop)
- [x] Enter/v only active on PR Groups panel

---

## Validation Commands

### Static Analysis
```bash
pnpm check
```
EXPECT: Zero type errors

### Unit Tests
```bash
pnpm test
```
EXPECT: All tests pass

### Lint
```bash
pnpm lint
```
EXPECT: No lint errors

### Manual Validation

- [ ] Start TUI with `pnpm dev` and a running orchestration
- [ ] Navigate to a PR group with j/k
- [ ] Press Enter — dashboard disappears, shell opens in worktree
- [ ] Run `pwd` in shell — confirms worktree path
- [ ] Exit shell (Ctrl+D) — dashboard reappears
- [ ] Verify same group still selected
- [ ] Press v — neovim opens at worktree
- [ ] Quit neovim (:q) — dashboard reappears
- [ ] Try Enter on non-existent worktree — error shown, no crash
- [ ] Footer shows ↵/v hints on panel 0
- [ ] Footer hides ↵/v hints on panel 1/2

---

## Acceptance Criteria

- [ ] `Enter` unmounts Ink cleanly (no rendering artifacts)
- [ ] Shell spawned with CWD at PR group's worktree path
- [ ] Shell uses user's default shell from SHELL env var
- [ ] Terminal restored to normal mode (no raw mode, cursor visible)
- [ ] On shell exit, Ink remounts with full dashboard state
- [ ] Dashboard state preserved across unmount/remount (selected panel, item, scroll)
- [ ] `v` opens neovim at worktree path
- [ ] After neovim exit, Ink remounts correctly
- [ ] `Esc` returns to dashboard from sub-views
- [ ] Handles missing worktree gracefully (error message, no unmount)

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Tests follow test patterns
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `fullscreen-ink` doesn't cleanly support unmount/remount | Medium | High | Bypass withFullScreen, use raw Ink render() + manual alt buffer |
| Terminal state corruption after takeover | Low | Medium | Reset terminal modes explicitly before remount |
| React state lost on unmount | N/A | N/A | Pass state via props (initialState), not internal refs |

## Notes

- `withFullScreen` is thin (enters alt buffer, renders, exits on quit). For takeover, we bypass it entirely and manage the alt buffer + Ink instance ourselves in `launch.ts`.
- The launch function changes from sync `void` to async `Promise<void>` — callers (CLI entry) need updating if they don't already await.
- `Esc` for sub-views is already handled implicitly: overlays toggle off via `d`/`l` — but adding explicit `Esc` to close overlay is a minor addition to useKeyboard.
