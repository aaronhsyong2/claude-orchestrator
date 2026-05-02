---
title: "PRD v2: Claude Orchestrator — Autonomous Agent TUI Dashboard"
category: guide
tags:
  - orchestrator
  - autonomous-agents
  - tui
  - workflow
  - prd
created: 2026-05-02
updated: 2026-05-02
status: active
related:
  - "[Original PRD](claude-orchestrator-prd.md)"
  - "[ADR 001: Core Design Decisions](../decisions/001-design-decisions.md)"
---

# PRD v2: Claude Orchestrator

This PRD supersedes the original draft PRD. All design decisions from the grill-me session (ADR 001) are incorporated.

## Problem Statement

The developer has a mature workflow pipeline (grill-me → PRD → issues → PR plan → triage → pick-up → implement → review) that produces high-quality results. However, once work reaches the execution phase, there is no way to run multiple agents concurrently with visibility. Each agent session requires manual babysitting for permission prompts (primarily from ECC GateGuard hooks), and there is no dashboard to monitor progress across parallel workstreams. The developer trusts the pipeline enough that ~90% of implementation completes without intervention, but has no tooling to leverage that trust at scale. Additionally, when an agent does need input, there is no efficient way to provide context to a new session without re-fetching everything from scratch.

## Solution

Build a standalone TUI-based CLI (`claude-orchestrator`) that:

1. Reads PR plan documents (contract defined in `claude-config/skills/to-pr-plan/FORMAT.md`) to build a dependency-aware work queue
2. Spawns autonomous `claude -p` sessions in isolated git worktrees with NDJSON output parsing
3. Provides a Lazygit-style terminal dashboard (Ink) with left sidebar panels (PR Groups, Issues, Activity) and a context-sensitive main view
4. Supports interactive takeover via Ink unmount/remount — user drops into worktree shell, runs `claude` interactively or edits manually, then returns to dashboard
5. Maintains ephemeral context files per issue so that fresh Claude sessions (retries, takeover, resumption) inherit prior context without re-fetching
6. Runs project-defined serial verification (lint → typecheck → build → test → e2e) after each issue with fail-fast behavior
7. Manages a review pipeline: self-review (standalone, on-demand) → PR creation → PR review (standalone, on-demand) → comment fixing (worker pool) → severity-gated review cycles
8. Creates real PRs for user to manually review and merge, with merge detection unlocking dependent PR groups
9. Supports graceful shutdown with auto-resume on next start via file-based state + git cross-referencing

## User Stories

1. As a developer, I want to see all active PR groups and their progress in a Lazygit-style dashboard, so that I get full visibility without switching terminal tabs
2. As a developer, I want agents to run as `claude -p` subprocesses without permission prompts, so that execution is not blocked when I'm away
3. As a developer, I want to press Enter on a PR group to drop into its worktree shell, so that I can run interactive `claude` or edit code manually when an agent needs help
4. As a developer, I want the orchestrator to respect both intra-group dependencies (from issue `## Blocked by` sections) and cross-group dependencies (from `> Depends on: PR N` in PR plan), so that agents don't start work before prerequisites are complete
5. As a developer, I want verification to run serially (lint → typecheck → build → test → e2e) with fail-fast behavior after each issue, so that regressions are caught immediately without wasting time on downstream steps
6. As a developer, I want one commit per issue within a PR group, so that git history remains granular and reviewable
7. As a developer, I want to press `v` to open Neovim at a PR group's worktree, so that I can review code in my editor
8. As a developer, I want the orchestrator to create real PRs (not drafts) after self-review passes, so that my review step is a natural checkpoint
9. As a developer, I want each agent to start with fresh context via `claude -p`, so that accumulated context from previous issues doesn't cause drift
10. As a developer, I want to press `d` to toggle a dependency graph panel, so that I understand what's blocked and what's running
11. As a developer, I want PR groups (not individual issues) to be the unit of work with one worktree per group, so that related changes stay in a single coherent PR without git conflicts
12. As a developer, I want branch naming to follow my convention (`<prefix>/issue-<range>`) as defined in the PR plan, so that branches are consistent with my existing workflow
13. As a developer, I want project-specific verification commands defined in `.orchestrator/config.json`, so that the orchestrator works across different projects with different toolchains
14. As a developer, I want agents to attempt self-fix via fresh spawn with context file on verification failures (up to 2 retries), so that minor issues resolve automatically without re-fetching all context
15. As a developer, I want a `⚠` badge on the TUI plus a macOS system notification when an agent needs my input, so that I only context-switch when necessary even if I'm in another app
16. As a developer, I want the orchestrator to parse GitHub issues' `## Blocked by` sections for intra-group dependencies and `> Depends on: PR N` for cross-group dependencies, so that the dependency graph is derived from existing data
17. As a developer, I want PR plan documents (produced by `/to-pr-plan` skill) to be the source of truth for the work queue, so that all state is file-based and parseable
18. As a developer, I want worktrees to persist until a PR is merged, so that PR comment fixes can be pushed to the same branch without re-cloning
19. As a developer, I want the orchestrator to work with my existing `/pick-up` skill (auto-confirming routing decisions), so that I don't rebuild proven workflows
20. As a developer, I want ephemeral context files per issue (containing approach taken, files modified, errors, open questions, git diff stat) that persist across retries and takeover but are deleted on successful verification, so that fresh Claude sessions inherit prior work cheaply
21. As a developer, I want up to 3 concurrent PR groups processing simultaneously with issues serial within each group, so that I get parallelism without git conflicts
22. As a developer, I want PR groups to only start when all cross-group dependencies are merged to the base branch, so that I don't deal with merge conflicts or rebasing
23. As a developer, I want a self-review step (standalone, outside worker pool) after all issues in a PR group complete, with severity-gated review cycles (up to 3, stop when no critical/high), so that code quality is enforced before PR creation
24. As a developer, I want a PR reviewer (standalone, outside worker pool) that checks all previous comments were addressed and project rules are followed, so that review quality is consistent
25. As a developer, I want PR comment fixes to run the full verification pipeline locally before pushing, so that CI minutes are not wasted on broken code
26. As a developer, I want one batch commit per PR review cycle (`fix: address PR review comments (cycle N)`), so that review-fix history is clean
27. As a developer, I want `orchestrator start` to auto-resume from previous state files cross-referenced with git state, so that I can quit and restart without losing progress
28. As a developer, I want graceful shutdown (finish current step, write state) on `q`, with force kill on double `q` or Ctrl+C, so that worktrees are never left in unknown state
29. As a developer, I want `orchestrator start --fresh` to explicitly clear state, so that destructive actions require explicit intent
30. As a developer, I want merge detection via `gh pr view` polling every 10s with fallback to `git fetch` every 5s after 3 consecutive API failures, so that the orchestrator degrades gracefully when GitHub is unavailable
31. As a developer, I want a configurable base branch (default `main`) per project, so that projects using `develop` or other strategies are supported
32. As a developer, I want `.orchestrator/` gitignored except `config.json`, so that runtime state doesn't pollute the repo but config is shared
33. As a developer, I want a lock file preventing two orchestrator instances on the same project, so that concurrent runs don't corrupt state
34. As a developer, I want to run multiple orchestrator instances across different projects simultaneously, so that I can orchestrate independent projects in parallel
35. As a developer, I want number keys (1-3) to jump between sidebar panels, j/k to navigate within panels, and `+` to cycle screen modes (normal/half/full), so that navigation matches Lazygit muscle memory
36. As a developer, I want silent retries for transient failures (API rate limits, process crashes) and immediate notifications for blocking errors (git conflicts, disk full), so that I'm not bothered by recoverable issues
37. As a developer, I want rule files configurable in `.orchestrator/config.json` (defaulting to `CLAUDE.md`, `.claude/rules/**/*.md`, `docs/decisions/*.md`), so that the PR reviewer enforces project-specific rules
38. As a developer, I want logs persisted in `.orchestrator/logs/` for debugging, cleaned only on `--fresh`, so that I can investigate failures after the fact

## Implementation Decisions

### Architecture

- **Standalone Node/TS CLI** — separate repo `claude-orchestrator`, compiled via tsup for distribution
- **TUI framework** — Ink (React for terminal). Claude Code itself uses Ink, proving it works for this domain
- **No database** — all state is file-based (`.orchestrator/status/*.json`, context files, logs)
- **No Agent SDK** — raw `claude -p --output-format stream-json` subprocess with NDJSON parsing. CLI interface is stable contract. Simpler to test with mock processes
- **No PTY** — Claude headless is pipe-based. Interactive takeover via Ink unmount/remount, not subprocess stdin piping

### Deep Modules

| Module | Interface | Responsibility |
|---|---|---|
| **PR Plan Parser** | `parse(filePath) → PlanData` | Regex parsing of PR plan markdown, dependency graph construction, cross-group dependency resolution |
| **Scheduler** | `getReadyGroups()`, `assignWork()`, `onMerge()` | Dependency graph traversal, concurrency cap enforcement, ready-pool evaluation |
| **Worker Manager** | `spawnWorker(issue, worktree)`, `killWorker(id)` | `claude -p` subprocess lifecycle, NDJSON stream parsing, context file management |
| **Worktree Manager** | `create(branch, base)`, `remove(branch)` | Git worktree operations, branch creation from configurable base branch, cleanup on merge |
| **Verification Pipeline** | `verify(cwd, commands) → Result` | Serial command execution (lint → typecheck → build → test → e2e), fail-fast, error capture |
| **Review Orchestrator** | `selfReview(group)`, `prReview(prNumber)` | Severity classification (critical/high/medium/low), cycle counting, comment-addressed verification, rule injection from config |
| **Status Manager** | `read(group)`, `write(group, data)`, `reconcile(gitState)` | File I/O for `.orchestrator/status/*.json`, crash recovery via git state cross-reference, context file lifecycle |
| **Merge Detector** | `start(prNumber, callback)` | Polling state machine: GitHub (10s) → git fallback (5s) after 3 failures → recovery poll (60s) |
| **Notification Service** | `notify(message, level)` | TUI badge updates + macOS `osascript` system notifications, configurable enable/disable |
| **TUI Dashboard** | Ink component tree | Lazygit-style layout, panel navigation, keybindings, screen modes, status rendering |
| **CLI Entry** | `orchestrator <command>` | Arg parsing, lock file management, startup/shutdown orchestration |

### Agent Topology

| Agent Role | Pool | Trigger |
|---|---|---|
| Scheduler | standalone | Always running within orchestrator process |
| Worker (up to 3) | worker pool | Scheduler assigns: implement issue OR fix PR comments |
| Self-reviewer | standalone (outside pool) | On-demand after PR group issues complete |
| PR reviewer | standalone (outside pool) | On-demand after PR created |

Workers handle implementation and PR comment fixes. Reviews never compete for worker slots.

### Worker Prompt

Minimal, skill-driven:
```
/pick-up <issue-number>

<if context file exists>
Context from previous attempt:
<contents of context file>
</if>
```

Auto-confirm all routing decisions. `/pick-up` handles issue fetching and routing to implementation.

### PR Comment Fix Prompt

Direct prompt (not `/pick-up`):
```
Fix the following PR review comments on PR #<number>.
<comments>
Each fix should be a separate logical change in one batch commit.
Do not modify code unrelated to the review comments.
<if context file exists>
Context from previous attempt:
<contents of context file>
</if>
```

### Execution Flow Per PR Group

```
1. Scheduler identifies PR group as ready (all cross-group deps merged)
2. Worktree Manager creates worktree + branch from base_branch
3. For each issue (dependency order):
   a. Worker Manager spawns claude -p with /pick-up prompt + context file
   b. Agent implements issue, commits (one commit per issue)
   c. Agent writes context file before exit
   d. Verification Pipeline runs: lint → typecheck → build → test → e2e
      - Pass → delete context file, continue to next issue
      - Fail → write error to context file, fresh spawn retry (max 2)
      - Still failing → mark NEEDS_INPUT, notify user
   e. Worker Manager tears down claude session
4. Self-reviewer runs (standalone): reviews all commits on branch
   - Classifies findings: critical/high/medium/low
   - If critical/high → worker fixes, re-review (up to 3 cycles)
   - If only medium/low → proceed, note them
   - If still critical/high after 3 cycles → NEEDS_INPUT
5. Push branch, create real PR
6. PR reviewer runs (standalone): reviews PR, posts comments
   - Verifies all previous comments addressed
   - Checks project rule compliance (from config rule_files)
   - If comments → worker fixes (one batch commit per cycle), verify before push
   - Review loop: up to 3 cycles, severity-gated
   - Approved → notify user "ready to merge"
7. User merges manually
8. Merge Detector detects merge → Scheduler unlocks dependent groups
9. Worktree Manager cleans up worktree
```

### State and File Structure

```
.orchestrator/
├── config.json              # project config (committed to git)
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

Gitignored except `config.json`. Logs persist for debugging. Cleaned on `--fresh`.

### Config Shape

```json
{
  "base_branch": "main",
  "max_concurrent_agents": 3,
  "max_retries_on_fail": 2,
  "max_review_cycles": 3,
  "verify": [
    { "name": "lint", "command": "pnpm run check" },
    { "name": "typecheck", "command": "pnpm run typecheck" },
    { "name": "build", "command": "pnpm run build" },
    { "name": "test", "command": "pnpm run test -- --run" },
    { "name": "e2e", "command": "pnpm run test:e2e" }
  ],
  "rule_files": [
    "CLAUDE.md",
    ".claude/rules/**/*.md",
    "docs/decisions/*.md"
  ],
  "issue_source": {
    "type": "github",
    "repo": "org/repo-name"
  },
  "notifications": {
    "system": true
  }
}
```

### Tooling

- **Package manager:** pnpm
- **Build tool:** tsup (CLI bundling)
- **Linter/formatter:** Biome
- **Test framework:** vitest
- **TS target:** ES2022
- **Module system:** ESM (required by Ink 5)
- **TUI framework:** Ink

### Merge Detection State Machine

```
GITHUB_POLLING (default)
  → gh pr view every 10s
  → 3 consecutive failures → switch to GIT_FALLBACK

GIT_FALLBACK
  → git fetch + branch check every 5s
  → background: gh pr view every 60s
  → GitHub responds OK → switch back to GITHUB_POLLING
```

### Error Escalation Matrix

| Failure | Behavior |
|---|---|
| Verification fails, retries remaining | Silent retry with fresh spawn |
| Verification fails, retries exhausted | NEEDS_INPUT + system notification |
| `claude -p` crashes | Retry once, notify on second crash |
| `gh` CLI fails | Retry with backoff, notify after 3 failures |
| Git conflict in worktree | Immediate notification |
| Disk full / worktree creation fails | Immediate notification |
| Review cycle exhausted (still critical/high) | NEEDS_INPUT + system notification |

### Interactive Takeover (Model A)

No stdin piping to live process. On `Enter`:
1. Ink unmounts (dashboard disappears)
2. User gets shell in selected PR group's worktree
3. User runs `claude` interactively, edits code, runs commands
4. User exits shell (Ctrl+D or `exit`)
5. Ink remounts, dashboard reappears with current state
6. Orchestrator resumes from where it left off

Context file persists across takeover — new Claude session reads it for continuity.

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior through the module's public interface, not implementation details. Mock external dependencies (git, `claude -p`, `gh`, filesystem) at the boundary. Tests should be deterministic — no real subprocess spawning, no real git operations, no real GitHub API calls.

### Modules to Test (all except CLI Entry)

| Module | Test Strategy |
|---|---|
| **PR Plan Parser** | Parse real PR plan fixtures. Verify dependency graph construction, cross-group deps, status filtering. Edge cases: empty groups, standalone issues, malformed markdown. |
| **Scheduler** | Mock merge events and PR plan data. Verify ready-pool calculation, concurrency cap enforcement, dependency unlocking on merge. |
| **Worker Manager** | Mock `claude -p` subprocess (stdin/stdout pipes). Verify NDJSON parsing, context file creation/deletion, lifecycle state transitions. |
| **Worktree Manager** | Mock git commands. Verify branch creation from configurable base, cleanup on merge, error handling for existing worktrees. |
| **Verification Pipeline** | Mock command execution. Verify serial ordering, fail-fast behavior, error capture format, retry triggering. |
| **Review Orchestrator** | Mock reviewer output with severity classifications. Verify cycle counting, severity gating logic, comment-addressed checking. |
| **Status Manager** | Test against temp filesystem. Verify read/write, crash recovery reconciliation with mock git state, context file lifecycle. |
| **Merge Detector** | Mock `gh` and `git` commands. Verify polling state machine transitions: GitHub → fallback → recovery. |
| **Notification Service** | Mock `osascript`. Verify config toggle, message formatting. |
| **TUI Dashboard** | Ink testing patterns (snapshot tests for layout, interaction tests for keybindings). |
| **CLI Entry** | Integration test — verify subcommand routing, lock file behavior. |

### Coverage Target

80%+ across all modules. Deep modules (Parser, Scheduler, Worker Manager, Verification Pipeline, Status Manager, Merge Detector) are highest priority.

## Out of Scope

- **Web UI** — TUI first, web later if needed
- **Docker containerization** — worktrees provide sufficient isolation
- **Database for state** — files are the state layer
- **Agent SDK** — raw `claude -p` subprocess is simpler and more stable
- **True stdin piping for takeover** — Ink unmount/remount with new session is sufficient
- **Issue-level parallelism within PR groups** — serial to avoid git conflicts
- **Auto-merge** — user manually merges as trust gate
- **Multi-repo orchestration** — one target project at a time
- **CI/CD integration** — orchestrator runs locally, not in pipelines
- **Cost tracking** — handled by existing ECC hooks if enabled
- **Modifying external skills** — fork later as separate effort
- **Sound notifications** — user sometimes works without sound

## Further Notes

- The `/to-pr-plan` skill already exists in `claude-config` with a stable FORMAT.md contract. The orchestrator's PR Plan Parser must match those regex patterns exactly.
- Skill extraction from ECC plugin (code-review, PR creation) is a follow-up effort after the orchestrator core is working.
- Consider adding a `--dry-run` mode that shows what would be scheduled without spawning agents.
- The orchestrator itself is built with pnpm + tsup + Biome + vitest + ESM (Ink 5 requirement).
- This PRD incorporates all 26 design decisions from ADR 001. The original PRD draft remains as historical context but this document is the source of truth.
