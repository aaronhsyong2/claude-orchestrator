---
title: "PRD: First-Run Orchestrator Fixes"
category: guide
tags:
  - prd
  - dogfooding
  - orchestrator
  - first-run
  - test-isolation
  - observability
  - worker-prompts
  - session-resume
  - decision-channel
created: 2026-05-04
updated: 2026-05-04
status: active
related:
  - "[First-Run Issues](first-run-issues.md)"
  - "[Upstream Pipeline PRD](upstream-pipeline-prd.md)"
  - "[Upstream Pipeline PR Plan](upstream-pipeline-pr-plan.md)"
  - "[GitHub Issue #38](https://github.com/aaronhsyong2/claude-orchestrator/issues/38)"
  - "[Parent Epic: #26](https://github.com/aaronhsyong2/claude-orchestrator/issues/26)"
---

# PRD: First-Run Orchestrator Fixes

## Problem Statement

The orchestrator was dogfooded on epic #26 (upstream pipeline, 2026-05-04). The run surfaced 16 issues — 3 fixed during the session, 13 remaining. The two most critical: **verification always fails** because tests read real `.orchestrator/` state from the running orchestrator, and `cli.test.ts` depends on a build artifact (`dist/cli.js`) that doesn't exist in worktrees. Until these are fixed, no orchestrator-managed run can complete the verify gate on this project.

Secondary issues block observability (no human-readable logs, no stuck detection), waste tokens (redundant `/pick-up` routing, repeated blocked-tool retries), and leave UX gaps (no resume command, no mid-task decision channel).

## Solution

Five PRs in priority order, plus one immediate config fix:

1. **PR 1 — Make verify and tests work** (#5, #9, #14): Fix test isolation so no test reads real `.orchestrator/` state. Fix `cli.test.ts` to run from source instead of build artifact.
2. **PR 2 — Observability** (#7, #8): Add human-readable worker logs and stuck detection with 90-second stale threshold.
3. **PR 3 — Smarter worker prompts + session resume** (#10, #12, #13): Remove `/pick-up` from worker spawns, add configurable routing, inject worker constraints and issue context upfront. Add `--session-id` + `--resume` to worker spawns for context persistence across retries.
4. **PR 4 — Resume command UX** (#6): Add `resume` alias or rename `start` to `run`.
5. **PR 5 — Post-escalation human input** (#4): TUI `r` key + CLI `orchestrator respond` for providing guidance after `needs-input` escalation. Resumes existing worker session with human's input. Full design below.
6. **Immediate — Remove Prettier hook** (#16): Remove global Prettier PostToolUse hook. Project uses Biome.

### Dropped issues (not bugs)

- **#11** (MCP tools unavailable to workers): Correct behavior. `--print` mode workers shouldn't have MCP access — security boundary.
- **#15** (git stash baseline check): Root cause fixed by PR 1. Pre-existing test failures indicate broken main, not something to design around.

## User Stories

1. As a developer running the orchestrator, I want verification to pass when all new tests pass, so that workers can complete the full coding → verify → PR loop without false failures.
2. As a developer running the orchestrator, I want tests to be isolated from real runtime state, so that test results are deterministic regardless of whether the orchestrator is actively running.
3. As a developer running the orchestrator, I want `cli.test.ts` to pass without a prior build step, so that the full test suite works in worktrees and fresh clones.
4. As a developer monitoring workers, I want human-readable logs showing what the worker is doing (reading files, running tests, editing code), so that I never need to parse raw NDJSON to understand worker activity.
5. As a developer monitoring workers, I want the TUI to stream live worker actions in the activity panel, so that I have real-time visibility into worker progress.
6. As a developer monitoring workers, I want stuck detection that flags workers with no activity for 90 seconds, so that I can distinguish "working" from "stuck."
7. As a developer monitoring workers, I want elapsed time displayed per step (e.g., "verifying (2m 34s)"), so that I have a sense of how long each phase takes.
8. As a developer configuring the orchestrator, I want routing rules in config.json that map issue types to downstream skills, so that worker routing is not hardcoded.
9. As a developer writing plan files, I want to override routing per PR group, so that specific groups can use different skills than the default.
10. As a developer, I want the orchestrator to pre-fetch issue body and agent brief before spawning workers, so that workers start coding immediately without fetching issue data themselves.
11. As a developer, I want workers to know their constraints upfront (non-interactive mode, no MCP tools, `gh`/`git` work from worktree), so that they don't waste tokens discovering these constraints through failures.
12. As a developer, I want `/pick-up` to remain available as an interactive skill for manual use, so that I can still use it when working on issues directly.
13. As a developer using the CLI, I want an `orchestrator resume` command (or neutral `orchestrator run`), so that the command name doesn't imply "fresh start" when resuming a failed run.
14. As a developer, I want to provide guidance to workers that hit `needs-input` after max retries, so that they can resume with human direction instead of being a dead end.
15. As a developer using the TUI, I want to press `r` on a `needs-input` group to open an editor with error context pre-filled, so that I can write guidance without leaving the dashboard.
16. As a developer without the TUI running, I want `orchestrator respond <group>` to open the same editor and run the full pipeline after I save, so that I can unblock escalated groups from the CLI.
17. As a developer, I want retry counts to reset after I provide human input, so that the worker gets a fresh set of attempts with my guidance.
18. As a developer, I want worker sessions to persist across retries via `--session-id` + `--resume`, so that retried workers retain full context of previous attempts without cold-starting.

## Implementation Decisions

### PR 1: Make verify and tests work

- All test files must use temporary `baseDir` via `mkdtempSync`. No test reads real `.orchestrator/` state.
- Temp directories cleaned up in `afterEach`/`afterAll` with `rmSync(tmpDir, { recursive: true, force: true })`.
- `cli.test.ts` changes `CLI_PATH` from `node dist/cli.js` to `tsx src/cli.ts`. `tsx` is already a devDependency.
- Acceptance criteria: full test suite passes without prior build step and with an active orchestrator run in the background.

### PR 2: Observability

- Two commits, one PR. Each issue is a separate commit.
- **Readable logs (#7):** `parseNdjsonLine()` in worker-manager already processes every NDJSON line. Add parallel write to `<issue>.readable.log` extracting `assistant` message text and `tool_use` name/summaries. TUI log viewer (`l` key) points at `.readable.log`. No new module — lives in worker-manager.
- **Stuck detection (#8):** Time-based, 90-second silence threshold. Worker NDJSON stream updates a `lastActivity` timestamp. TUI status poller compares `lastActivity` against current time. Display: `verifying (2m 34s)` normally, `verifying (2m 34s) ⚠ no activity` when stale. Live worker actions (e.g., "Reading types.ts", "Running tests") stream into TUI ActivityPanel component, not into log files.

### PR 3: Smarter worker prompts + session resume

- Remove `/pick-up #N` from `buildPrompt()`. `/pick-up` remains as an interactive-only skill.
- Add `routing` field to `OrchestratorConfig` (optional). Maps label combinations to downstream skills/prompts. Fallback chain: plan-level override per PR group → config routing rules.
- Orchestrator pre-fetches issue body + agent brief via `gh issue view --json` before spawning. Injects into worker prompt directly. Worker never fetches issue data itself.
- System prompt injection tells worker: "You are in non-interactive mode. MCP tools are unavailable. Use `gh` CLI for GitHub operations. `gh` and `git` commands work from your worktree directory — do not `cd` elsewhere."
- This eliminates worker `cd` attempts (#10), redundant `/pick-up` routing (#12), and repeated blocked-tool retries (#13).
- **Session resume:** Workers spawn with `--session-id <uuid>`. On retry, orchestrator uses `--resume <session-id>` instead of fresh spawn. Worker keeps full conversation history (files read, edits made, errors hit) across retries. No cold start on retry. Validated: Claude Code `--session-id` + `--resume` preserves multi-turn context in `--print` mode.
- **Session ID storage:** New deep module `session-manager` with simple interface: `getSessionId(groupSlug, issue, baseDir?)` / `createSession(groupSlug, issue, baseDir?)`. Files stored in `.orchestrator/sessions/<group>/<issue>.json`. Callers never touch files directly.
- **Compaction:** Trust `--print` mode auto-compaction for now. Add proactive context management if compaction causes issues in practice.

### PR 4: Resume command UX

- Add `resume` case to CLI switch statement that delegates to `start` logic. Or rename `start` to `run` (neutral about fresh vs resume).

### PR 5: Post-escalation human input

Design completed via dedicated grill-me session (2026-05-04). Not mid-task interruption — post-escalation input only. Worker retries until max retries exhausted, escalates to `needs-input`, then human provides guidance and worker resumes.

**Core mechanism:** Session resume (`--session-id` + `--resume` from PR 3) eliminates the cold-start problem. Human's guidance becomes the next message in an existing conversation. Worker retains full context of what it tried, what failed, and what files it touched.

**Dual input path:**
- **TUI:** `r` key on `needs-input` groups opens `$EDITOR` with pre-filled template. Active only when selected group has `step_result: 'needs-input'`.
- **CLI:** `orchestrator respond <group>` opens `$EDITOR` with same template. Works without TUI running.

**Editor template** (git commit message style):
```
# Respond to: <group> #<issue>
#
# Error: <step_result from status>
# Last actions: <last 10 lines from readable log>
# Worktree: <path>
#
# Write your guidance below. Lines starting with # are ignored.
# Save and quit to resume. Empty file aborts.

```

**After human responds:**
- Retry count resets to zero. Full retries available again.
- `orchestrator respond` runs the full group pipeline: resume session → verify → self-review → PR → merge wait. Single-group `processGroup()` equivalent.
- TUI `r` key writes guidance + re-queues into the running scheduler loop (if orchestrator is still alive for other groups).

**Session ID storage:** Managed by `session-manager` deep module (same as PR 3). `orchestrator respond` calls `getSessionId()` to find the session to resume.

**Stopgap limitation:** The orchestrator is currently one-shot (`assignWork()` returns when all groups complete or escalate). If the `needs-input` group is the only group, orchestrator exits. Human must use `orchestrator respond` CLI. Long-running orchestrator mode will eliminate this gap — see dependency note below.

**Dependency:** PR 5 requires session resume from PR 3. Long-running orchestrator mode (required for upstream pipeline) will supersede the `orchestrator respond` stopgap by keeping the orchestrator alive to receive human input via TUI.

### Immediate config fix

- Remove Prettier `PostToolUse` hook from `~/.claude/settings.json`. Done (2026-05-04).
- `Bash(npx prettier:*)` stays in allowed tools — useful for projects that do use Prettier.
- Reason: project uses Biome. Formatter choice is project-level. Agents decide when to format.

## Testing Decisions

Good tests verify external behavior through the module's public interface, not implementation details. Tests should be deterministic, isolated, and fast.

### Modules to test

1. **`buildPrompt()`** (PR 3) — currently a 4-line pure function, will grow with routing + context injection + system prompt. Test: given issue body, routing config, and constraints → produces expected prompt string. Prior art: existing `worker-manager.test.ts`.
2. **`parseNdjsonLine()` + readable log formatter** (PR 2) — pure transform from NDJSON line → structured message + readable string. Test: given raw NDJSON lines of various types → produces correct readable output. Prior art: existing worker-manager tests.
3. **Stale detection logic** (PR 2) — timestamp comparison function. Test: given lastActivity timestamp and current time → returns stale/not-stale. Testable without TUI.
4. **Routing resolver** (PR 3) — new module. Resolves routing from plan-level override → config rules → default. Test: given config routing map + optional plan override → returns correct skill/prompt. Should be a deep module with simple interface.
5. **Test isolation verification** (PR 1) — not a new test module, but existing tests must pass with an active `.orchestrator/status/` directory present. Acceptance test: create fake state in real `.orchestrator/`, run full suite, all pass.
6. **Session manager** (PR 3) — deep module. Test: create/get/lookup session IDs. Verify file storage and retrieval. Verify isolation with temp baseDir.
7. **`orchestrator respond` flow** (PR 5) — test: given a `needs-input` group with existing session, respond writes guidance to context, resets retry count, resumes session. Mock editor interaction and worker spawn. Verify full pipeline execution.

### Prior art

- `config.test.ts`, `status-manager.test.ts` — use `mkdtempSync` + `rmSync` pattern for temp dirs
- `worker-manager.test.ts` — tests `parseNdjsonLine()`, `buildPrompt()`
- `orchestrate.test.ts` — uses in-memory status store with mocked deps

## Out of Scope

- **Long-running orchestrator event loop** — required for upstream pipeline, will supersede `orchestrator respond` stopgap. Not designed here.
- **Mid-task interruption** — workers cannot be interrupted mid-execution. Human input is post-escalation only.
- **Proactive context window management** — trust `--print` auto-compaction for now
- **MCP tool access for workers** (#11) — correct security boundary, not a bug
- **Baseline test diffing** — overengineered; fix the tests instead of designing around broken main
- **Building `dist/` in worktrees** — wrong fix; tests should not depend on build artifacts
- **Upstream pipeline epic work** (#26) — blocked until PR 1 lands; resumes after

## Further Notes

- Priority order is strict: PR 1 → PR 2 → PR 3 → PR 4 → PR 5. PR 1 unblocks all future orchestrator runs. PR 5 depends on session resume from PR 3.
- Issues #1, #2, #3 were fixed during the dogfooding session (commits `de8b16e`, `39d4b3c`). Issue #16 is fixed by the immediate Prettier hook removal (done 2026-05-04).
- The first-run issues document lives at `docs/guide/first-run-issues.md` and serves as the source of truth for issue details.
- Session resume (`--session-id` + `--resume`) was validated to preserve multi-turn context in `--print` mode via manual testing (2026-05-04).

### Dependency: Long-running orchestrator mode

The upstream pipeline PRD implicitly requires a long-running orchestrator (epic discovery polling, approval gates, implementation queue). The current orchestrator is one-shot: `assignWork()` returns when all groups complete or escalate. This means:

- `orchestrator respond` (PR 5) is a **stopgap** — it works but requires the human to run a separate command after the orchestrator exits.
- The upstream pipeline **cannot start** until long-running mode is designed. Epic polling, approval gates, and `needs-input` response all require the orchestrator to stay alive.
- Long-running mode should be designed as a prerequisite for the upstream pipeline PRD, not as part of this first-run fixes PRD.

## References

- First-run issues doc: `docs/guide/first-run-issues.md`
- Parent epic: #26 (upstream pipeline)
- Upstream pipeline PR plan: `docs/guide/upstream-pipeline-pr-plan.md`
- GitHub issue: [#38](https://github.com/aaronhsyong2/claude-orchestrator/issues/38)
