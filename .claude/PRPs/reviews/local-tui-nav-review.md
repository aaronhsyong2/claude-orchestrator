# Code Review: TUI Keyboard Navigation (Issue #12)

**Branch**: feat/tui-dashboard  
**Date**: 2026-05-03  
**Reviewer**: code-reviewer agent  
**Files reviewed**:
- src/tui/types.ts
- src/tui/use-keyboard.ts
- src/tui/DependencyGraphView.tsx
- src/tui/LogTailView.tsx
- src/tui/Footer.tsx
- src/tui/Dashboard.tsx
- src/tui/use-keyboard.test.ts
- src/tui/Dashboard.test.tsx

---

## Findings

### [HIGH] Path traversal — LogTailView does not validate groupSlug before using it in fs calls

**File**: src/tui/LogTailView.tsx:25-26

`groupSlug` is a `string | null` prop passed directly into `path.resolve()` to construct a filesystem path, with no validation against traversal sequences:

```typescript
// CURRENT — unvalidated
const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);

// The rest of the codebase guards slugs at every fs boundary:
assertValidSlug(groupSlug);   // src/status-manager.ts:33, :58, :76, :84, :96
```

The project already has `assertValidSlug` from `src/validation.ts` which enforces `/^[a-z0-9][a-z0-9-]*$/` and is called at every other fs boundary in `status-manager.ts` and `worker-manager.ts`. A crafted `groupSlug` such as `../../etc/passwd` (unlikely from the TUI but possible in test or future API usage) would escape the intended directory.

**Fix**: add validation at the top of the function body, before constructing the path:

```typescript
import { assertValidSlug } from '../validation.js';

export function LogTailView({ groupSlug, baseDir }: LogTailViewProps): ReactNode {
  if (!groupSlug) { /* … empty state … */ }
  assertValidSlug(groupSlug);           // throws on traversal attempts
  const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);
  // …
}
```

---

### [HIGH] Synchronous I/O in a render function

**File**: src/tui/LogTailView.tsx:46-63

`readLatestLogLines` calls `fs.existsSync`, `fs.readdirSync`, and `fs.readFileSync` directly from the component render body. In a terminal UI running on Node.js event loop, synchronous disk reads block all I/O (keyboard input, status polling, ink redraws) for the duration of the read. This is a correctness hazard in addition to a performance one: if a log file is large, the TUI will freeze on every render triggered by the poller.

The rest of the codebase (use-status-poller.ts) uses async polling. `LogTailView` should follow the same pattern — read the file once on mount and on an interval, not on every render.

**Fix**: move file reading into a `useEffect` + `useState` inside a `useLogLines` hook:

```typescript
function useLogLines(groupSlug: string | null, baseDir: string, maxLines: number): readonly string[] {
  const [lines, setLines] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!groupSlug) { setLines([]); return; }
    const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);
    const next = readLatestLogLines(logDir, maxLines);  // sync fn kept, called once per effect
    setLines(next);
    const id = setInterval(() => setLines(readLatestLogLines(logDir, maxLines)), 2000);
    return () => clearInterval(id);
  }, [groupSlug, baseDir, maxLines]);
  return lines;
}
```

This makes the fs calls happen once per effect activation and every 2 s, not on every Ink render pass.

---

### [MEDIUM] Footer key collision when both overlays are off — two hints share key `+`

**File**: src/tui/Footer.tsx:18-23 & src/tui/use-keyboard.ts:75-82

`getHints` returns `['d', 'deps']` and `['l', 'logs']` as separate entries, but uses `key` as the `<Box key={key}>` prop. The keys `'1-3'`, `'j/k'`, `'+'`, `'d'`, `'l'`, `'q'` are all unique so the React key prop is fine. However, the `+` hint label only shows the _current_ mode (`layout:normal`, `layout:half`, `layout:full`), not what it _does_ (cycle layout). This is a UX inconsistency vs how `d` and `l` are handled (those show `:on` when active, making them readable as toggles). The `+` hint is purely a status indicator with no affordance that pressing `+` advances the cycle. Consider `['+', `→${screenMode}`]` or keeping the current wording but documenting the intent.

This is a cosmetic issue but worth aligning for a consistent keybinding language in the footer.

---

### [MEDIUM] `getHints` receives `_activePanel` but never uses it

**File**: src/tui/Footer.tsx:11-23

`_activePanel` is accepted as a parameter (prefixed with `_` to acknowledge the lint suppression) but the hints array is identical regardless of which panel is active. If panel-contextual hints are intended (e.g., showing `j/k: group` vs `j/k: issue` depending on `activePanel`), the dead parameter should be wired up. If panel-contextual hints are not planned, the parameter should be removed from both `getHints` and the `FooterProps` interface to avoid confusing future readers.

---

### [MEDIUM] Missing test coverage for path traversal guard in LogTailView

**File**: src/tui/Dashboard.test.tsx (LogTailView describe block, lines 206-223)

The two existing tests cover null slug and non-existent directory. There is no test that verifies a traversal-style slug (e.g., `../../etc`) is rejected, and no test that verifies a valid slug with an existing log file renders log content. The first gap becomes more important once the HIGH path traversal issue is fixed — adding a guard is only valuable if a test enforces it remains present.

---

### [LOW] `navigateDown` / `navigateUp` are inner functions defined after `useInput` that close over stale `activePanel` / `issueCount` / `groupCount`

**File**: src/tui/use-keyboard.ts:52-117

`useInput` captures `navigateDown` and `navigateUp` at registration time (Ink registers the handler once on mount). The functions themselves read `activePanel`, `groupCount`, and `issueCount` from the hook's closure. Because `useInput` in Ink re-registers on every render when dependencies change, this works correctly in practice — Ink's `useInput` calls the latest handler each render. However, the pattern is subtly order-dependent: the helper functions are declared _after_ `useInput` is called (lines 99-117), which is valid in JS due to hoisting but is an unusual and error-prone ordering. Moving `navigateDown` / `navigateUp` to be declared before `useInput` makes the data flow explicit and eliminates the hoisting dependency.

---

### [LOW] `DependencyGraphView` uses array index as key for the outer `Box` despite having a stable `group.pr_group` key

**File**: src/tui/DependencyGraphView.tsx:35

`key={group.pr_group}` is correctly used on the outer `<Box>`, which is good. No issue here — this is just confirming the biome-ignore on `noArrayIndexKey` in `LogTailView` is the right file.

---

### [LOW] `use-keyboard.test.ts` is a `.ts` file that imports JSX (`React.createElement`)

**File**: src/tui/use-keyboard.test.ts:1-3

The file contains no JSX syntax (all element creation is via `React.createElement`) so the `.ts` extension is correct and works today. However, the convention in this project is `.tsx` for files that deal with React components (all other component tests are `.tsx`). If the file ever gains a JSX expression, the extension will need to change. Renaming to `.test.tsx` now avoids a future rename-in-git.

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | pass   |
| HIGH     | 2     | warn   |
| MEDIUM   | 3     | info   |
| LOW      | 3     | note   |

**Verdict: WARNING — 2 HIGH issues should be resolved before merge.**

The two HIGH issues are related: `LogTailView` skips the slug validation guard that every other filesystem boundary in the project enforces, and it performs synchronous I/O during render. Both are straightforward to fix. The MEDIUM items are polish-level concerns. The LOW items are purely stylistic.
