# Code Review — Pass 4 (feat/tui-dashboard)

**Reviewer:** code-reviewer agent (claude-sonnet-4-6)
**Date:** 2026-05-03
**Branch:** feat/tui-dashboard
**Scope:** All uncommitted changes from `git diff HEAD`

---

## Files Reviewed

| File | Lines | Changed |
|------|-------|---------|
| `src/validation.ts` | 19 | Added `isValidSlug` export |
| `src/validation.test.ts` | 75 | Added `isValidSlug` test suite |
| `src/tui/types.ts` | 11 | Added `ScreenMode` + `OverlayMode` types |
| `src/tui/Footer.tsx` | 52 | Refactored to contextual hints |
| `src/tui/Dashboard.tsx` | 58 | Wired `useKeyboard`, overlays, screen modes |
| `src/tui/Dashboard.test.tsx` | 335 | Added Footer/DependencyGraphView/LogTailView tests |
| `src/tui/use-keyboard.ts` | 121 | (read in full — unchanged, no diff) |
| `src/tui/LogTailView.tsx` | 93 | (read in full — unchanged, no diff) |
| `src/tui/DependencyGraphView.tsx` | 47 | (read in full — unchanged, no diff) |

---

## Findings

No issues at CRITICAL or HIGH severity were found.

---

### MEDIUM

None found.

---

### LOW

**[LOW-1] `Footer` key prop collision when both `d` and `l` overlays are active**

File: `src/tui/Footer.tsx:44`

The `key` prop is `${key}-${label}`. When both overlay toggles are in their "off" state the hints list contains `d-deps` and `l-logs`, which are distinct. When `deps` overlay is active the hint becomes `d-deps:on` and when `logs` is active it becomes `l-logs:on`. These are still unique, so no actual collision exists today.

However, if a future hint is added with the same key+label combination the bug would be silent. The previous pattern used just `key` (the keyboard character), which is guaranteed unique per hint entry. The current composite is fine for the present set but worth a note for awareness — not a blocking issue.

Confidence: 60% — this does not cause a problem with the current hint list. Logging as LOW for awareness only.

**Verdict: SKIP — below the 80% confidence threshold for a real issue. Recorded for completeness.**

---

### Notes (informational, not issues)

- **`isValidSlug` extraction** (`src/validation.ts:4-6`): Clean DRY refactor — `assertValidSlug` now delegates to `isValidSlug`, and the new export is exercised by five dedicated test cases covering happy path, alphanumeric, traversal, empty string, and leading hyphen. Well done.

- **`isValidSlug` test — single-char slug gap**: The `isValidSlug` test suite does not include a single-character slug (e.g. `'a'`), whereas `assertValidSlug` does. The regex `^[a-z0-9][a-z0-9-]*$` requires one leading `[a-z0-9]` followed by zero or more `[a-z0-9-]`, so a single char is valid. The existing `assertValidSlug` test covers it transitively, so this is not a coverage gap in practice. Noted as a thoroughness observation only.

- **`LogTailView` "dir exists but no .log files" test**: The new test correctly creates a temp dir, writes a `.txt` file, renders the component, awaits `act`, and asserts `No logs`. Cleanup is in a `finally` block — correct.

- **`useKeyboard` overlay comment** (`src/tui/use-keyboard.ts:104`): Updated comment "OverlayMode is a single value; toggling one key naturally replaces the other" is accurate and clear.

- **`Dashboard.tsx` layout math**: `sidebarWidth`/`mainWidth` strings are consistent and exhaustive across all three `ScreenMode` values. The `screenMode !== 'full'` conditional correctly hides the sidebar in full mode.

- **`Footer` contextual hints**: `JK_LABEL` deliberately has no entry for panel index `2` (Activity), so `jkLabel` is `undefined` and the spread correctly omits the `j/k` hint. The `activePanel` type is `number` with no upper bound — passing `activePanel > 2` produces no hint, which is safe.

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | pass |
| HIGH | 0 | pass |
| MEDIUM | 0 | pass |
| LOW | 0 | pass (1 note below confidence threshold) |

**Verdict: APPROVE** — No CRITICAL, HIGH, MEDIUM, or confirmed LOW issues. All three previous-round fixes are correctly applied and well-tested. Changes are ready to merge.
