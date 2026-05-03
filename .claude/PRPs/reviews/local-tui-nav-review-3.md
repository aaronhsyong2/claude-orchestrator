# TUI Navigation — Third-Pass Code Review

**Branch**: feat/tui-dashboard
**Pass**: 3 of 3
**Reviewer**: code-reviewer agent (claude-sonnet-4-6)
**Date**: 2026-05-03

---

## Scope of This Pass

Changes since pass 2:
- `LogTailView.tsx` — "Invalid group" red text for bad slugs
- `Dashboard.tsx` — dead `'0%'` sidebarWidth removed; dynamic `sidebarWidth`/`mainWidth`
- `Dashboard.test.tsx` — async `act()` for log-dir test; new DependencyGraphView + LogTailView suites
- `use-keyboard.ts` — comment for `d`/`l` mutual-exclusion note
- `Footer.tsx` — key prop changed to `${key}-${label}`
- `validation.ts` — `isValidSlug` extracted and exported

---

## Findings

### LOW — `isValidSlug` exported but not directly unit-tested

**File**: `/Users/ayong/github/personal/claude-orchestrator/src/validation.test.ts`

`isValidSlug` was extracted from `assertValidSlug` and is now exported as its own public function. It is called directly in `LogTailView.tsx` to guard path construction and branch the UI. The existing `assertValidSlug` tests exercise the same regex indirectly, but `isValidSlug` has no dedicated test block.

Given that `LogTailView` relies on `isValidSlug` returning `false` for path-traversal slugs — making this a security-relevant boundary — direct tests are worth adding:

```typescript
// validation.test.ts
import { assertValidIssue, assertValidSlug, isValidSlug } from './validation.js';

describe('isValidSlug', () => {
  it('returns true for valid slug', () => {
    expect(isValidSlug('pr-1')).toBe(true);
  });
  it('returns false for traversal slug', () => {
    expect(isValidSlug('../../etc/passwd')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });
});
```

---

### LOW — `d`/`l` toggle does not enforce mutual exclusion at the state level

**File**: `/Users/ayong/github/personal/claude-orchestrator/src/tui/use-keyboard.ts`, lines 105–112

The comment says `d` and `l` are mutually exclusive, but the toggle logic does not enforce it — each key only self-toggles:

```typescript
if (input === 'd') {
  setOverlay((prev) => (prev === 'deps' ? 'none' : 'deps'));
}
if (input === 'l') {
  setOverlay((prev) => (prev === 'logs' ? 'none' : 'logs'));
}
```

In the current implementation this is actually fine because `setOverlay` replaces the entire value; if overlay is `'logs'` and the user presses `d`, the result is `'deps'`, not both. The mutual exclusion is an emergent property of `OverlayMode` being a single value, not a set. The comment is accurate in effect but could mislead future maintainers into thinking extra guard logic is needed. No bug here — this is a documentation-only nit.

---

### LOW — `LogTailView` renders "No logs" after a valid but empty-file log directory

**File**: `/Users/ayong/github/personal/claude-orchestrator/src/tui/LogTailView.tsx`, lines 75–93

`readLatestLogLines` returns `[]` both when the directory does not exist and when it exists but contains no `.log` files. From the user's perspective both cases display "No logs", which is correct. However, the test at line 240 (`'shows no logs when log dir does not exist'`) only exercises the missing-directory path. There is no test for the case where the directory exists but is empty, which is a distinct code path (`files.length === 0` branch at line 84). This is a minor coverage gap, not a bug.

---

## No Issues Found at CRITICAL or HIGH Severity

All previously flagged issues from passes 1 and 2 have been correctly resolved:

| Fix | Verified |
|-----|----------|
| LogTailView shows "Invalid group" (red) for invalid slugs | Yes — lines 47-55, `isValidSlug` guard |
| Dashboard dead `'0%'` sidebarWidth removed | Yes — `sidebarWidth` is now always `'50%'` or `'33%'` |
| Dashboard test `act()` wrapping | Yes — lines 247, 256, 270 |
| `use-keyboard.ts` comment for `d`/`l` exclusion | Yes — line 104 |
| Footer key prop changed to `${key}-${label}` | Yes — line 44 |

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | pass   |
| HIGH     | 0     | pass   |
| MEDIUM   | 0     | pass   |
| LOW      | 3     | note   |

**Verdict: APPROVE** — No CRITICAL or HIGH issues. The three LOW findings are all non-blocking: one minor coverage gap on the newly exported `isValidSlug` function, one comment-clarity nit in `use-keyboard.ts`, and one missing test for the empty-log-directory branch. All are safe to merge as-is.
