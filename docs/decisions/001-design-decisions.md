---
title: "ADR 001: Core Design Decisions"
category: decision
tags:
  - architecture
  - tui
  - orchestrator
  - design
created: 2026-05-02
updated: 2026-05-02
status: active
related:
  - "[Claude Orchestrator PRD](../guide/claude-orchestrator-prd.md)"
---

# ADR 001: Core Design Decisions

Decisions made during the initial design session (grill-me). These supersede any conflicting statements in the original PRD draft.

## 1. TUI Framework: Ink

Ink (React for terminal). Overwhelming TypeScript ecosystem dominance. Claude Code itself uses Ink. Interactive takeover solved via unmount/remount pattern.

## 2. Claude Interface: Raw `claude -p` Subprocess

Raw `claude -p` with `--output-format stream-json` (NDJSON). No Agent SDK dependency. CLI interface is stable contract. NDJSON parsing is trivial. Simpler to test with mock processes.

## 3. State Management: File-Based Only

All state in `.orchestrator/status/*.json`. Polled every 1-3s by TUI. No in-memory store. No sub-second updates needed — avoids visual noise from rapid refreshes.

## 4. Interactive Takeover: Observe + New Session (Model A)

No stdin piping to live process. Takeover = Ink unmounts, user gets shell in worktree, runs `claude` interactively or edits manually. On exit, Ink remounts. Agent's atomic commit-per-issue means worktree is always clean between issues.

Rejected Model B (true stdin pipe) because it requires PTY or Agent SDK, breaking decision #2.

## 5. Ephemeral Context Files

Per-issue context file at `.orchestrator/context/<pr-group>/<issue>.md`. Contains: approach taken, files modified, verification output (if failed), open questions, git diff stat. Deleted on successful verification. Persists across retries and takeover sessions to avoid re-fetching full context.

## 6. Verification Pipeline: Serial Fail-Fast

`lint → typecheck → build → test → e2e`. Strictly serial. No sub-agents needed. Agent runs each command sequentially, stops on first failure. Lint and typecheck could theoretically parallelize but not worth the complexity for sub-second commands.

## 7. Retry Strategy: Fresh Spawn Per Retry

Each retry is a fresh `claude -p` process. Context file carries forward error output and what was tried. Max retries: 2 (configurable). Avoids keeping processes alive between verify and retry.

## 8. Concurrency Model: One Agent Per PR Group

Up to `max_concurrent_agents` (default 3) PR groups run simultaneously. Within each group, issues processed serially in dependency order. No issue-level parallelism within a group — same worktree means git conflicts.

## 9. PR Group Scheduling: Dependency-Gated

PR group only starts when all cross-group dependency issues are merged to base branch. Orchestrator may run fewer than max agents if dependency chain creates bottleneck. Correctness over throughput.

Scheduling logic: parse PR plan → build cross-group dependency graph → find groups with all deps merged → start up to max_concurrent → on merge, re-evaluate ready pool.

## 10. Merge Gating: User Merges Manually

Orchestrator creates real PRs (not draft). User reviews and merges manually. Orchestrator detects merge event, unlocks dependent PR groups.

## 11. Agent Topology

| Agent Role | Pool | Trigger |
|---|---|---|
| Scheduler | standalone | Always running |
| Worker (up to 3) | worker pool | Scheduler assigns: implement issue OR fix PR comments |
| Self-reviewer | standalone (outside pool) | On-demand after PR group issues complete |
| PR reviewer | standalone (outside pool) | On-demand after PR created |

Workers stay focused: implement or fix. Reviews never compete for worker slots.

## 12. Review Cycle: Severity-Gated with Cap

Up to 3 review cycles. After each cycle, classify findings as critical/high/medium/low. If critical or high remain, worker fixes and re-review. If only medium/low remain after any cycle, create PR with comments noting them. If still critical/high after 3 cycles → NEEDS_INPUT.

PR reviewer also verifies: all previous review comments addressed, project rule compliance (from config-defined rule files), no regressions (verification pipeline re-runs after each fix).

## 13. PR Comment Fixing

Direct prompt with PR comments (not `/pick-up`). One batch commit per review cycle: `fix: address PR review comments (cycle N)`. Full verification pipeline runs locally before push — no wasted CI minutes.

## 14. Rule Injection: Config-Defined Paths

`.orchestrator/config.json` has `rule_files` array. Defaults:
```json
["CLAUDE.md", ".claude/rules/**/*.md", "docs/decisions/*.md"]
```
Global rules from `~/.claude/rules/common/*.md` inherited automatically by `claude -p` process. Project-level overrides add on top.

## 15. Worker Prompt: Minimal, Skill-Driven

```
/pick-up <issue-number>

<if context file exists>
Context from previous attempt:
<contents of context file>
</if>
```

Auto-confirm all routing decisions. `/pick-up` handles fetching issue body and routing to implementation. No need to inject issue body or PR plan into prompt.

## 16. PR Plan Format

Already defined in `claude-config/skills/to-pr-plan/FORMAT.md`. Orchestrator parses using documented regex patterns. Intra-group deps from issue `## Blocked by` sections. Cross-group deps from `> Depends on: PR N` in PR plan.

## 17. Project Tooling

pnpm, tsup (CLI bundling), Biome (lint+format), vitest (testing), ES2022 target, ESM (required by Ink 5).

## 18. CLI Interface: Standalone, CWD-Scoped

Standalone CLI binary. CWD determines project. `.orchestrator/` dir is per-project. Lock file prevents double-run on same project. Multiple instances across different projects supported.

Subcommands:
- `orchestrator init` — scaffold `.orchestrator/config.json`
- `orchestrator start <plan>` — parse plan, launch TUI, begin work
- `orchestrator start --fresh <plan>` — clear state, start clean
- `orchestrator status` — non-TUI state printout

## 19. Configurable Base Branch

`.orchestrator/config.json` has `base_branch` field. Defaults to `main`. Supports `develop` or other branching strategies per project.

## 20. Dashboard Layout: Lazygit-Style

Left sidebar (~33%) with 3 stacked panels: PR Groups, Issues, Activity. Main view (~67%) context-sensitive based on selection. Number keys 1-3 jump panels, j/k navigate within panel. Green bold border for active panel. `+` cycles screen modes (normal/half/full).

Keybindings: `d` deps graph, `l` logs, `Enter` takeover, `v` nvim, `q` quit.

Status icons: `✓` done, `⚙` working, `⏸` blocked, `⚠` needs input, `·` pending.

## 21. `.orchestrator/` Directory Structure

```
.orchestrator/
├── config.json              # project config (committed)
├── lock                     # PID lock file
├── status/
│   └── <pr-group-slug>.json # per-group status
├── context/
│   └── <pr-group-slug>/
│       ├── <issue>.md       # ephemeral context per issue
│       └── pr-comments.md   # ephemeral context for PR fixes
└── logs/
    └── <pr-group-slug>/
        └── <issue>.log      # raw claude output per issue
```

Gitignored except `config.json`. Logs persist for debugging. Cleaned on `orchestrator start --fresh`.

## 22. Startup: Auto-Resume

`orchestrator start` auto-resumes if state files exist. Cross-references status files with git state (ground truth). `--fresh` flag explicitly clears state.

## 23. Shutdown: Graceful

`q` stops scheduling new issues, waits for current steps to finish, writes state. Double `q` or Ctrl+C force kills. Auto-resume picks up on next start using git state + status files.

## 24. Merge Detection: Polling with Fallback

Poll `gh pr view` every 10s. After 3 consecutive GitHub API failures, fall back to `git fetch` + branch check every 5s. Background poll GitHub every 60s to detect recovery and switch back.

## 25. Error Escalation Matrix

| Failure | Behavior |
|---|---|
| Verification fails, retries remaining | Silent retry |
| Verification fails, retries exhausted | NEEDS_INPUT + notification |
| `claude -p` crashes | Retry once, notify on second crash |
| `gh` CLI fails | Retry with backoff, notify after 3 failures |
| Git conflict in worktree | Immediate notification |
| Disk full / worktree creation fails | Immediate notification |
| Review cycle exhausted (still critical/high) | NEEDS_INPUT + notification |

## 26. Notifications

TUI badge (`⚠`) + macOS system notification via `osascript`. System notifications configurable (can disable in config).

```json
{ "notifications": { "system": true } }
```
