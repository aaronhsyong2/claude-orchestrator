---
title: "First Run Issues — Orchestrator Dogfooding"
category: guide
tags:
  - dogfooding
  - issues
  - orchestrator
  - first-run
created: 2026-05-04
updated: 2026-05-04
status: active
related:
  - "[Upstream Pipeline PR Plan](upstream-pipeline-pr-plan.md)"
  - "[Parent Epic: #26](https://github.com/aaronhsyong2/claude-orchestrator/issues/26)"
---

# First Run Issues — Orchestrator Dogfooding

Issues encountered during the first real use of the orchestrator (upstream pipeline epic #26, 2026-05-04). Intended as input for a grooming session.

## Summary

**Run:** `orchestrator start docs/guide/upstream-pipeline-pr-plan.md` on PR 1 (issues #28, #29)
**Outcome:** Worker implemented #28 successfully (new types, CRUD, config, 27 new tests passing). Failed at verify gate due to pre-existing test failures + orchestrator's own state file interference. Escalated to `needs-input` after max retries.

| # | Issue | Severity | Fixed? | Category |
|---|-------|----------|--------|----------|
| 1 | `--verbose` flag missing | Blocker | Yes | CLI compat |
| 2 | NDJSON verbose types flood stderr | Medium | Yes | Logging |
| 3 | Worker tool permissions blocked | Blocker | Yes | Permissions |
| 4 | No mid-task decision channel | Design gap | No | Architecture |
| 5 | Leftover state pollutes tests | Low | Manual | Test isolation |
| 6 | No explicit `resume` command | Low | No | UX |
| 7 | Raw NDJSON logs, no readable view | High | No | Observability |
| 8 | No progress/stuck detection | High | No | Observability |
| 9 | Verify fails from orchestrator's own state | Blocker | No | Test isolation |
| 10 | Worker `cd` to main repo blocked | Medium | No | Permissions |
| 11 | MCP tools unavailable to workers | Medium | No | Permissions |
| 12 | `/pick-up` wastes first spawn on routing | Medium | No | Worker prompt |
| 13 | Blocked tools retried across spawns | Medium | No | Worker prompt |
| 14 | Pre-existing test failures fail verify | Blocker | No | Verification |
| 15 | Worker uses `git stash` to check baselines | Low | No | Worker prompt |
| 16 | Prettier hook fights worker edits | Medium | No | Hooks |

### By category

- **Blockers preventing completion (must fix):** #9, #14
- **Observability (high-value UX):** #7, #8
- **Worker prompt optimization (token savings):** #12, #13, #15
- **Permissions/environment:** #10, #11, #16
- **Design gaps (future):** #4, #6
- **Already fixed:** #1, #2, #3

---

## Issue 1: `--verbose` flag required for `--print` + `--output-format=stream-json`

**Severity:** Blocker — worker fails immediately
**Symptom:** Worker exits with `Error: When using --print, --output-format=stream-json requires --verbose`
**Root cause:** Claude CLI changed to require `--verbose` when combining `--print` with `--output-format=stream-json`. The `spawnClaudeProcess` function didn't include it.
**Fix applied:** Added `--verbose` to spawn args in `worker-manager.ts`. Committed `de8b16e`.
**Follow-up:** None — fixed in session.

---

## Issue 2: Verbose NDJSON types flood stderr with "unparseable" warnings

**Severity:** Medium — noisy but non-blocking
**Symptom:** `[worker-manager] unparseable NDJSON for feat-epic-foundation/28: {"type":"rate_limit_event"...}` repeated many times.
**Root cause:** `--verbose` flag adds `user`, `rate_limit_event`, `tool_use`, `tool_result` message types. `parseNdjsonLine()` only recognized `system`, `assistant`, `result` — everything else logged as warning.
**Fix applied:** Added `isKnownNdjsonType()` filter to suppress warnings for known verbose-only types. Committed `39d4b3c`.
**Follow-up:** Consider whether any verbose types are worth consuming (e.g., `tool_use` for TUI progress display).

---

## Issue 3: Worker tool permissions blocked in `--print` mode

**Severity:** Blocker — worker stalls on every tool call
**Symptom:** Worker log shows `"This command requires approval"` and `"This Bash command contains multiple operations"` errors. Worker retries, escalates to `needs-input`.
**Root cause:** Global `~/.claude/settings.json` had limited `allowedTools`. Workers run in `--print` mode which can't prompt for interactive approval. Missing: `cd`, `gh issue/pr`, `git push/pull/worktree`, `rm`, `cp`, `mv`, `pnpm install`.
**Fix applied:** Expanded global settings `permissions.allow` with comprehensive tool patterns. Not committed (global config, outside repo).
**Follow-up:**
- Should the orchestrator validate that required permissions are configured before spawning workers?
- Should there be a project-level `.claude/settings.json` for orchestrator-managed repos so workers don't depend on the user's global config?
- Document required permissions in orchestrator setup guide.

---

## Issue 4: No mid-task decision channel for workers

**Severity:** Design gap — no current workaround
**Symptom:** When a worker hits an ambiguous decision point, it has no way to ask the human. It either guesses (and possibly fails verification) or stalls.
**Root cause:** `--print` mode is fire-and-forget. No IPC channel between running worker and TUI for interactive questions.
**Fix applied:** None — mitigated by writing detailed agent briefs that minimize ambiguity.
**Follow-up:**
- Design a decision channel (e.g., worker writes to `.orchestrator/context/<slug>/decision.md`, TUI polls and surfaces it, human responds, worker resumes).
- Alternatively, accept retry loop as the mechanism (wrong guess → fail verification → retry with error context).
- File as issue for future implementation.

---

## Issue 5: Leftover runtime state pollutes test runs

**Severity:** Low — dev experience annoyance
**Symptom:** `orchestrate.test.ts` fails because real `.orchestrator/status/*.json` and `.orchestrator/shutdown` files from a previous orchestrator run leak into test assertions.
**Root cause:** `hasExistingState()` reads from real `.orchestrator/status/` directory. Tests don't override `baseDir`, so they pick up real state. Manual cleanup (`rm .orchestrator/status/*.json .orchestrator/shutdown`) required before tests pass.
**Fix applied:** Manual cleanup each time.
**Follow-up:**
- `orchestrate.test.ts` should use a temp `baseDir` so it's isolated from real state.
- Or add a `beforeEach`/`afterEach` that cleans `.orchestrator/status/` in the test harness.
- Consider `orchestrator start --fresh` flag that auto-cleans before starting (may already exist — `cli.test.ts` references `--fresh`).

---

## Issue 6: No `orchestrator resume` — only fresh `start`

**Severity:** Low — UX gap
**Symptom:** After a failed run, user must know to run `orchestrator start` again (which internally detects and resumes). The command name `start` implies fresh start, not resume.
**Root cause:** Resume is implicit inside `start`. No dedicated `resume` command or explicit resume messaging.
**Fix applied:** None.
**Follow-up:**
- Consider `orchestrator resume` alias or making resume behavior more explicit in CLI output.
- Or rename to `orchestrator run` which is neutral about fresh vs resume.

---

## Issue 7: Worker logs are raw NDJSON — no human-readable view

**Severity:** High — major observability gap
**Symptom:** User has no visibility into what the worker is actually doing. The orchestrator dashboard shows step status (`verifying`) but not what's happening within that step. Log files are raw NDJSON — hundreds of lines of JSON that require parsing to understand.
**Root cause:** Worker logs capture raw `claude --output-format stream-json` output. No human-readable log view exists. TUI activity panel only shows step transitions, not worker actions.
**Fix applied:** None.
**Follow-up:**
- Add a human-readable log mode: extract `assistant` text and `tool_use` names/summaries from NDJSON, write to a parallel `.readable.log` file.
- TUI log tail view (`l` key) should show the readable log, not raw NDJSON.
- Consider streaming worker activity into the TUI activity panel (e.g., "Reading types.ts", "Running tests", "Editing config.ts").
- The user should never need to run a python script to understand what their agent is doing.

---

## Issue 8: No indication of worker progress or stuck detection

**Severity:** High — user can't distinguish "working" from "stuck"
**Symptom:** Worker shows `verifying` for extended period. User has no way to know if worker is making progress, retrying, or stuck in a loop. No elapsed time display, no action counter, no heartbeat indicator.
**Root cause:** TUI only displays the current `step` from the status file. No progress metrics within a step. No stuck/timeout detection.
**Fix applied:** None.
**Follow-up:**
- Show elapsed time per step in TUI (e.g., `verifying (2m 34s)`).
- Show last worker action timestamp — if no activity for N seconds, flag as potentially stuck.
- Consider a heartbeat: worker updates `last_updated` on each tool call, TUI warns if stale.
- Add a "current action" field to status (e.g., "running tests", "reading file") updated from NDJSON stream.

---

## Issue 9: Verify step fails due to orchestrator's own runtime state

**Severity:** Blocker — causes false verification failure and escalation
**Symptom:** Worker completes implementation successfully, tests pass when run selectively, but `pnpm run test -- --run` in verify step fails because `orchestrate.test.ts` picks up the real `.orchestrator/status/*.json` from the active orchestrator run.
**Root cause:** `.orchestrator/` is gitignored, so worktrees don't get their own copy — they share the main repo's `.orchestrator/` directory. The orchestrator writes `feat-epic-foundation.json` to track the active group. `orchestrate.test.ts` calls `hasExistingState()` without a `baseDir` override, sees the real status file, and assertions fail.
**Fix applied:** None.
**Follow-up:**
- `orchestrate.test.ts` must use a temp `baseDir` — this is the root cause of issue #5 too.
- Alternatively, verify commands could run with an env var that points `baseDir` to a temp dir.
- This is the highest-priority fix — without it, every orchestrator-managed run will fail verification on this test.

---

## Issue 10: Worker `cd` to main repo blocked by Claude session directory restriction

**Severity:** Medium — worker works around it but wastes tokens
**Symptom:** Worker tried `cd /path/to/main/repo && gh issue view 28`, got blocked: "cd was blocked... may only change directories to the allowed working directories for this session."
**Root cause:** Worker runs in worktree directory. Claude Code restricts `cd` to the session's allowed directories. The worktree path is allowed, but the main repo path is not.
**Fix applied:** None — worker adapted by using `--repo` flag instead.
**Follow-up:**
- Consider spawning workers with both worktree AND main repo as allowed directories.
- Or document that workers should use `--repo` flag for `gh` commands.

---

## Issue 11: MCP tool permissions not configurable for workers

**Severity:** Medium — worker works around it but wastes tokens
**Symptom:** Worker tried `mcp__plugin_everything-claude-code_github__get_issue`, got "you haven't granted it yet." Fell back to `gh` CLI.
**Root cause:** MCP tools aren't in the global settings allowlist. Workers can't use MCP servers that the interactive session has access to.
**Fix applied:** None — worker used `gh` CLI instead.
**Follow-up:**
- Add MCP tool patterns to global settings if workers should use them.
- Or accept that workers use CLI tools only (simpler, more portable).

---

## Issue 12: Worker runs /pick-up skill which re-routes, wasting tokens on redundant analysis

**Severity:** Medium — token waste, not a blocker
**Symptom:** Worker's first action is reading `/pick-up` routing table (`ROUTING.md`), analyzing the issue category/state, recommending a route (`/prp-plan → /prp-implement`), then returning that as a result — instead of just implementing. The orchestrator then spawns a *second* pass where the worker actually starts coding.
**Root cause:** `spawnWorker` wraps the prompt with `/pick-up #28`. The `/pick-up` skill is a triage router that analyzes and recommends a downstream skill — it doesn't implement. So the first worker invocation is purely diagnostic, producing a routing recommendation that nobody acts on.
**Fix applied:** None.
**Follow-up:**
- Workers should skip `/pick-up` routing and go straight to implementation. The issue is already triaged (`ready-for-agent`), has an agent brief — routing is redundant.
- Consider a direct prompt template: "Implement issue #28 per the agent brief. Here's the issue body: ..."
- Or configure `/pick-up` to skip routing for `ready-for-agent` issues with agent briefs.

---

## Issue 13: Worker repeatedly tries blocked tools before adapting

**Severity:** Medium — token waste, retry noise
**Symptom:** Worker tried `mcp__plugin_everything-claude-code_github__get_issue` three separate times across the session — blocked every time. Also tried `cd /main/repo` twice — blocked every time. Each failure costs tokens and adds noise.
**Root cause:** Worker context resets between retry attempts (each is a fresh Claude session). The worker doesn't remember that MCP tools and `cd` were blocked in previous attempts. Retry context only captures errors, not "don't try this tool again."
**Fix applied:** None.
**Follow-up:**
- Retry context should include a "blocked tools" list that carries forward.
- Or add a system prompt hint: "You are running in --print mode. MCP tools are unavailable. Use `gh` CLI with `--repo` flag instead of `cd`."
- Better: inject available tool allowlist into worker prompt so it knows constraints upfront.

---

## Issue 14: Pre-existing `cli.test.ts` failures cause verify step to fail

**Severity:** Blocker — false positive verification failure
**Symptom:** `cli.test.ts` has 9 pre-existing failures (missing `dist/cli.js`). Worker correctly identifies them as pre-existing (verifies by running tests on base branch via `git stash`). But the verify step runs `pnpm run test -- --run` which includes `cli.test.ts`, so verify fails with exit code 1.
**Root cause:** Verify runs the full test suite. Pre-existing failures aren't excluded. Worker has no way to tell the verify step "these failures are pre-existing, ignore them."
**Fix applied:** None.
**Follow-up:**
- Fix the pre-existing `cli.test.ts` failures (root cause: `dist/cli.js` not built in worktree).
- Or add `pnpm run build` before `pnpm run test` in verify, or make cli.test.ts skip when dist missing.
- Or allow verify config to exclude known-failing test files.
- Or compare test results against base branch — only fail on *new* failures.

---

## Issue 15: Worker wastes tokens on `git stash` / `git stash pop` to verify pre-existing failures

**Severity:** Low — token waste, clever but unnecessary
**Symptom:** Worker ran `git stash && pnpm run test -- src/cli.test.ts && git stash pop` to prove failures are pre-existing. Good instinct, but this costs tokens, risks stash conflicts, and in one case the stash pop reverted formatting changes that needed re-applying.
**Root cause:** Worker has no baseline test results to compare against. Must manually verify by checking out base state.
**Fix applied:** None.
**Follow-up:**
- Run baseline tests before worker starts and provide results as context: "These tests fail on main: cli.test.ts (9 failures)."
- Or snapshot test results at worktree creation time.

---

## Issue 16: Worker formatting loop — Prettier fights with worker edits

**Severity:** Medium — wasted cycles
**Symptom:** Worker edits `Dashboard.test.tsx` to add `shutdownStatus: 'none'` props. Prettier reformats. Worker sees formatting changed, re-reads, re-edits to match expected format. This happened across multiple retry cycles.
**Root cause:** Worker's Edit tool output doesn't match Prettier's expectations (inline vs multiline props). PostToolUse hook runs Prettier after every Edit, changing what the worker just wrote. Worker detects the change and tries to fix it.
**Fix applied:** None.
**Follow-up:**
- Prettier hook is good — but worker needs to know it's running. Add to system prompt: "Prettier auto-formats after every edit. Write code that matches Prettier defaults."
- Or disable Prettier hook for worker sessions (workers can run `pnpm run check` themselves).
- The `ECC_HOOK_PROFILE=minimal` env var is set but Prettier hook may not respect it.

---

*This document will be updated as more issues are encountered during this session.*
