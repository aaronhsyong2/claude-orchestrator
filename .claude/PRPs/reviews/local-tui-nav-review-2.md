---
title: "Second-Pass Code Review: TUI Navigation Keybindings"
category: review
tags:
  - tui
  - security
  - code-quality
created: 2026-05-03
updated: 2026-05-03
status: active
related:
  - "../plans/tui-navigation-keybindings.plan.md"
---

# Second-Pass Code Review — TUI Navigation Keybindings

Branch: `feat/tui-dashboard`
Reviewed by: code-reviewer agent (claude-sonnet-4-6)
Date: 2026-05-03

## Scope

Files reviewed:
- `src/validation.ts` — added `isValidSlug` export
- `src/tui/LogTailView.tsx` — async useEffect+useState, isValidSlug guard
- `src/tui/Footer.tsx` — contextual j/k, + shows next mode
- `src/tui/use-keyboard.ts` — navigateDown/Up moved before useInput
- `src/tui/Dashboard.tsx` — wired keyboard state into layout
- `src/tui/Dashboard.test.tsx` — new Footer + LogTailView + DependencyGraphView tests
- `src/tui/use-keyboard.test.tsx` — renamed from .ts

## First-Pass Fix Verification

All 7 first-pass issues confirmed resolved:
- HIGH path traversal: `isValidSlug()` guard in LogTailView useEffect — FIXED
- HIGH sync I/O in render: moved to useEffect + 2s poll interval — FIXED
- MEDIUM _activePanel unused: wired for contextual j/k label — FIXED
- MEDIUM + label shows current: now shows next mode — FIXED
- MEDIUM missing tests: traversal guard test + log content test added — FIXED
- LOW navigateDown/Up ordering: moved before useInput — FIXED
- LOW .test.ts: renamed to .test.tsx — FIXED

---

## Findings

### [MEDIUM] LogTailView: invalid slug renders "No logs" instead of a distinct error state

File: `src/tui/LogTailView.tsx:37-44` and `src/tui/Dashboard.test.tsx:250-256`

When `groupSlug` is non-null but fails `isValidSlug`, the useEffect sets `lines = []` and
returns early. The render guard `if (!groupSlug)` is false (slug is non-null), so the component
renders the main body with `lines.length === 0 → "No logs"`.

The path traversal is blocked correctly. But the UX presents "No logs" identically for:
- A valid group with no log files yet
- A rejected invalid/traversal slug

Recommendation: add a separate render branch for the invalid-slug case:

```tsx
if (groupSlug && !isValidSlug(groupSlug)) {
  return (
    <Panel title="Logs" active={false}>
      <Box marginLeft={1}>
        <Text color="red">Invalid group</Text>
      </Box>
    </Panel>
  );
}
```

This also makes the test assertion more precise (expect "Invalid group" not "No logs").

---

### [MEDIUM] Dashboard.tsx: `sidebarWidth = '0%'` is dead code in full mode

File: `src/tui/Dashboard.tsx:27`

```typescript
const sidebarWidth = screenMode === 'full' ? '0%' : screenMode === 'half' ? '50%' : '33%';
```

The sidebar Box is conditionally excluded via `{screenMode !== 'full' && ...}`, so `'0%'` is
never used. The dead branch is misleading — it suggests `'0%'` collapses the sidebar via width
when actually conditional rendering does the work.

Fix:
```typescript
const sidebarWidth = screenMode === 'half' ? '50%' : '33%';
```

---

### [LOW] Dashboard.test.tsx: "no logs when log dir does not exist" test does not await act

File: `src/tui/Dashboard.test.tsx:240-248`

The test is synchronous but the component has a `useEffect`. It passes because the initial
`useState([])` state renders "No logs" before the effect runs. For consistency and resilience,
add `await act`:

```typescript
it('shows no logs when log dir does not exist', async () => {
  const { lastFrame } = render(...);
  await act(async () => {});
  expect(lastFrame()).toContain('No logs');
});
```

---

### [LOW] use-keyboard.ts: overlay mutual exclusion is implicit

File: `src/tui/use-keyboard.ts:104-111`

The `d` and `l` toggles are mutually exclusive by coincidence of the toggle pattern
(pressing `l` when `overlay === 'deps'` moves to `'logs'`, not back to `'none'`). This is
correct behavior but undocumented. A comment noting the invariant would prevent silent
regression if a third overlay is added.

---

### [LOW] Footer.tsx: key prop uses keybinding string — fragile if duplicates arise

File: `src/tui/Footer.tsx:44`

All current keys are unique, so no React warning today. Using `${key}-${label}` as the key
would be more defensive against future collisions.

---

## What Is Clean

- `isValidSlug` extraction: correct, non-breaking, properly consumed
- `LogTailView` polling lifecycle: cleanup via clearInterval is correct
- `use-keyboard.ts` navigateDown/Up ordering fix: correct
- `Footer.tsx` getHints pure function: well-structured, no side effects
- `NEXT_MODE` record: type-safe cycle
- `use-keyboard.test.tsx` rename: correct
- All new tests exercise meaningful behavior
- biome-ignore comment on selectedGroupIndex dep accurately documents intentional omission

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | pass   |
| HIGH     | 0     | pass   |
| MEDIUM   | 2     | warn   |
| LOW      | 3     | note   |

Verdict: APPROVE with notes — no blocking issues. MEDIUM items worth addressing before merge.
