---
title: "PRD: Claude Orchestrator — Autonomous Agent TUI Dashboard"
category: guide
tags:
  - orchestrator
  - autonomous-agents
  - tui
  - workflow
created: 2026-05-02
updated: 2026-05-02
status: draft
related: []
---

# PRD: Claude Orchestrator

## Problem Statement

The developer has a mature workflow pipeline (grill-me → PRD → issues → PR plan → triage → pick-up → implement → review) that produces high-quality results. However, once work reaches the execution phase, there is no way to run multiple agents concurrently with visibility. Each agent session requires manual babysitting for permission prompts (primarily from the ECC GateGuard hook), and there is no dashboard to monitor progress across parallel workstreams. The developer trusts the pipeline enough that ~90% of implementation completes without intervention, but has no tooling to leverage that trust at scale.

## Solution

Build a standalone TUI-based orchestrator (`claude-orchestrator`) that:

1. Reads PR plan documents to build a dependency-aware work queue
2. Spawns autonomous `claude --headless` sessions in isolated git worktrees
3. Provides a terminal dashboard showing progress across all active agents
4. Supports interactive takeover — drop into any agent session to steer it, then hand back to autonomous mode
5. Runs project-defined verification (build, lint, typecheck, tests, e2e) after each issue
6. Creates draft PRs for review when PR groups complete

Additionally, create a `/to-pr-plan` skill that bridges the gap between issue creation and orchestrated execution by interactively grouping issues into PR batches.

## User Stories

1. As a developer, I want to see all active agents and their progress at a glance, so that I don't need to switch between terminal tabs
2. As a developer, I want agents to run without permission prompts, so that execution is not blocked when I'm away
3. As a developer, I want to drop into any agent session interactively, so that I can steer it when implementation drifts from my intent
4. As a developer, I want the orchestrator to respect issue dependencies, so that agents don't start work before prerequisites are complete
5. As a developer, I want verification to run automatically after each issue, so that regressions are caught before the next issue starts
6. As a developer, I want one commit per issue within a PR group, so that git history remains granular and reviewable
7. As a developer, I want to open Neovim at an agent's worktree, so that I can review code in my editor before providing feedback
8. As a developer, I want the orchestrator to create draft PRs when all issues in a group are done, so that my review step is a natural checkpoint
9. As a developer, I want each agent to start with fresh context, so that accumulated context from previous issues doesn't cause drift
10. As a developer, I want the dependency graph visible in the TUI, so that I understand what's blocked and what's running
11. As a developer, I want PR groups (not individual issues) to be the unit of work, so that related changes stay in a single coherent PR
12. As a developer, I want branch naming to follow my convention (`<prefix>/issue-<range>`), so that branches are consistent with my existing workflow
13. As a developer, I want project-specific verification commands, so that the orchestrator works across different projects with different toolchains
14. As a developer, I want agents to attempt self-fix on verification failures before escalating to me, so that minor issues resolve automatically
15. As a developer, I want to see a notification badge when an agent needs my input, so that I only context-switch when necessary
16. As a developer, I want the orchestrator to parse `## Blocked by` sections from GitHub issues, so that the dependency graph is derived from existing data
17. As a developer, I want to interactively group issues into PR batches during planning, so that grouping reflects domain judgment not just mechanical rules
18. As a developer, I want the PR plan document to be the source of truth for the work queue, so that all state is file-based and git-tracked
19. As a developer, I want worktrees to persist until a PR is merged or abandoned, so that I can review and iterate without re-cloning
20. As a developer, I want the orchestrator to work with my existing skills (pick-up, tdd, triage), so that I don't rebuild proven workflows

## Implementation Decisions

### Architecture

- **Standalone Node/TS project** — separate repo `claude-orchestrator`, not embedded in `claude-config`
- **TUI framework** — `blessed` or `ink` (React for terminal) for the dashboard
- **No database** — all state is file-based (PR plan docs, status JSON files, orchestrator config)
- **No Docker** — git worktrees provide sufficient isolation for branch-level work

### Work Scheduling

- **Unit of work:** PR group (as defined in `docs/guide/*-pr-plan.md`)
- **Dependency source:** GitHub issues parsed on-demand via `gh issue list` + `## Blocked by` section parsing
- **Scheduling strategy:** Eventual consistency — fetch and rebuild dependency graph before each scheduling cycle
- **Concurrency:** Configurable cap per project (recommended: 3 concurrent agents)

### Worker Lifecycle

- **One git worktree per PR group** — lives until PR merged or abandoned
- **One `claude --headless` session per issue** — fresh context, no carryover between issues
- **Issue prompt:** Full issue body from GitHub, injected as the initial prompt
- **Environment:** `ECC_HOOK_PROFILE=minimal` or `ECC_GATEGUARD=off` to disable blocking hooks
- **CWD:** Worktree path, preventing writes to main repo

### Execution Flow Per PR Group

```
1. Create worktree + branch (<prefix>/issue-<range>)
2. For each issue (dependency order):
   a. Fetch issue body from GitHub
   b. Spawn claude --headless in worktree
   c. Agent implements issue
   d. Agent commits (one commit per issue)
   e. Verify: lint → build → typecheck → unit tests → e2e
      - Pass → teardown session, continue
      - Fail → agent retries (max from config)
      - Still failing → mark NEEDS_INPUT
   f. Teardown claude session
3. Spawn fresh claude for self-review
4. Push branch, create draft PR
5. Checkpoint: notify user for review
6. On merge → teardown worktree
```

### TUI Design

- **Default view:** Progress bars per PR group — quiet until something needs attention
- **Status indicators:** Idle, Working, Verifying, Done, Blocked, Needs Input
- **Notification:** `⚠` badge when agent needs input — bumps to top of list
- **Keybindings:**
  - `Enter` — interactive takeover of selected agent session
  - `Esc` — return to dashboard from takeover
  - `v` — open Neovim at selected agent's worktree (agent paused)
  - `d` — toggle dependency graph panel
  - `l` — tail logs for selected agent
  - `q` — quit orchestrator
- **Dependency graph panel:** ASCII visualization of PR group dependencies and status

### Progress Tracking

- **Workflow-step based:** Each issue progresses through: plan → implement → commit → verify
- **Agent self-reports** to `.orchestrator/status/<worker>.json`:
  ```json
  {
    "pr_group": "PR 3: #30-33",
    "branch": "refactor/issue-30-33",
    "current_issue": 31,
    "step": "implement",
    "steps": ["plan", "implement", "commit", "verify"],
    "issues_completed": [30],
    "issues_remaining": [32, 33],
    "blocked": false,
    "needs_input": null,
    "last_updated": "2026-05-02T14:30:00Z"
  }
  ```

### Interactive Takeover

- TUI pipes stdin/stdout to the running `claude --headless` process
- Agent is paused while user reviews in Neovim (process receives no input)
- After user returns from editor, agent resumes or receives user feedback
- Session state preserved — no restart needed

### Project Configuration

Per-project `.orchestrator/config.json`:

```json
{
  "verify": [
    { "name": "lint", "command": "pnpm run check" },
    { "name": "build", "command": "pnpm run build" },
    { "name": "typecheck", "command": "pnpm run typecheck" },
    { "name": "unit-tests", "command": "pnpm run test -- --run" },
    { "name": "e2e", "command": "pnpm run test:e2e" }
  ],
  "fix_commands": {
    "lint": "pnpm run check:fix"
  },
  "max_retries_on_fail": 2,
  "max_concurrent_agents": 3,
  "pr_plan_glob": "docs/guide/*-pr-plan.md",
  "github_repo": "ay-development-org/leadforge-project"
}
```

### Branch Naming

- Format: `<prefix>/issue-<range>`
- Prefix: defined per PR group in the PR plan document (e.g., `refactor`, `feat`, `fix`)
- Range: consecutive numbers compressed (e.g., `30-33`), non-consecutive listed (e.g., `22-24-25`)

### PR Plan Document Format

Standard format in `docs/guide/*-pr-plan.md`, parseable by orchestrator:

```markdown
## PR N: Description

**Branch prefix:** refactor
**Status:** pending | in-progress | done

| Issue | Title | Status |
|-------|-------|--------|
| #30 | Extract owners.tsx | Open |
| #31 | Extract clients.tsx | Open |
```

### Hook Configuration for Autonomous Agents

- ECC plugin hooks disabled via environment: `ECC_HOOK_PROFILE=minimal`
- GateGuard specifically: `ECC_GATEGUARD=off`
- Local GSD hooks (sensitive-path-guard, validate-commit) remain active
- Prettier/Biome formatting handled by project verify commands, not global hooks

### Skill Dependencies

Pipeline skills used by the orchestrator's agents:

| Skill | Source | Status |
|-------|--------|--------|
| `/pick-up` | claude-config (local) | Ready |
| `/tdd` | Matt Pocock (external) | Plan to fork |
| `/triage` | Matt Pocock (external) | Plan to fork |
| `/to-pr-plan` | claude-config (local) | NEW — to be created |
| `/project-docs` | claude-config (local) | Ready |
| Code review | ECC plugin | Plan to fork |
| PR creation | ECC plugin | Plan to fork |

## Testing Decisions

- Test the scheduler's dependency graph parsing against real PR plan docs
- Test worktree creation/teardown lifecycle
- Test status file read/write and TUI rendering
- Test interactive takeover stdin/stdout piping
- Test verification command execution and retry logic
- Integration test: end-to-end flow with a mock `claude --headless` that simulates issue completion

## Out of Scope

- Web UI — TUI first, web later if needed
- Docker containerization — worktrees provide sufficient isolation
- Database for state — files are the state layer
- Modifying Matt Pocock's skills — fork later as separate effort
- Multi-repo orchestration — one target project at a time
- CI/CD integration — orchestrator runs locally, not in pipelines
- Cost tracking — handled by existing ECC hooks if enabled

## Further Notes

- The `/to-pr-plan` skill should be created first as a standalone skill in `claude-config`, since the orchestrator depends on its output format
- Skill extraction from ECC plugin (code-review, PR creation) is a follow-up effort after the orchestrator core is working
- The PR plan document format must be stable — it's the contract between `/to-pr-plan` and the orchestrator's scheduler
- Consider adding a `--dry-run` mode to the orchestrator that shows what would be scheduled without spawning agents
