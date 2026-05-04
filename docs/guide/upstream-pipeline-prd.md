---
title: "Upstream Pipeline — PRD"
category: guide
tags:
  - prd
  - epic
  - pipeline
  - orchestrator-design
created: 2026-05-04
updated: 2026-05-04
status: active
epic_issue: 26
related:
  - "[Orchestrator PRD v2](./claude-orchestrator-prd-v2.md)"
  - "[Session Workflow Journal](./session-workflow-journal.md)"
  - "[PR Plan](./claude-orchestrator-pr-plan.md)"
  - "[Design Decisions](../decisions/001-design-decisions.md)"
---

# Upstream Pipeline — PRD

Extend the orchestrator to manage the full idea-to-merge lifecycle by adding pre-implementation stages, epic discovery, and approval gates.

## Problem Statement

The orchestrator currently handles coding through merge — stages 2-7 of the observed workflow. But the upstream pipeline (PRD creation, issue breakdown, PR plan generation) is entirely manual, requiring the user to run skills in separate Claude Code sessions and manually chain artifacts between them. The user must remember what stage each idea is at, manually trigger each transition, and explicitly tell the orchestrator when a PR plan is ready for implementation. There is no unified view of all work items across pipeline stages.

## Solution

Extend the orchestrator to track work items from PRD approval through merge as a single continuous pipeline. The orchestrator discovers new epics via GitHub issue labels, presents them for review in the TUI dashboard, automates the PRD-to-PR-plan conversion, and queues approved PR plans for sequential implementation. The user's primary interaction surface remains the TUI dashboard — reviewing artifacts in their editor and approving stages with a single keypress.

## User Stories

1. As an orchestrator user, I want the orchestrator to discover new epics by polling GitHub for issues labeled `epic`, so that I don't need to manually register work items.
2. As an orchestrator user, I want to see discovered epics in the TUI dashboard with their current pipeline stage, so that I have a unified view of all work.
3. As an orchestrator user, I want to approve a PRD from the TUI by pressing a key, so that I can signal readiness without leaving the dashboard.
4. As an orchestrator user, I want the orchestrator to automatically spawn a worker that runs `/to-issues` and `/to-pr-plan` after I approve a PRD, so that issue breakdown and PR plan creation happen without manual intervention.
5. As an orchestrator user, I want to review the generated PR plan in my editor before implementation starts, so that I can verify issue grouping and dependency ordering.
6. As an orchestrator user, I want to approve a PR plan from the TUI by pressing a key, so that I can greenlight implementation without running CLI commands.
7. As an orchestrator user, I want only one epic in the implementation stage at a time, so that worktrees don't conflict and PRs don't create merge chaos.
8. As an orchestrator user, I want approved epics to queue for implementation in the order I approved them, so that I control priority.
9. As an orchestrator user, I want pre-implementation stages (PRD review, issue creation, plan creation, plan review) to run concurrently across multiple epics, so that the pipeline stays full while one epic is implementing.
10. As an orchestrator user, I want the epic's status file to track the full lifecycle from discovery through merge, so that I can resume and inspect state at any point.
11. As an orchestrator user, I want the TUI to show which epic is currently implementing and which are queued, so that I understand the execution order.
12. As an orchestrator user, I want the orchestrator to link epics to their PRD files via the `epic_issue` frontmatter field, so that discovery and local artifacts are connected.
13. As an orchestrator user, I want the epic GitHub issue body to contain the PRD doc path, so that the link is bidirectional.
14. As an orchestrator user, I want the `/to-issues` and `/to-pr-plan` skills to run non-interactively when spawned by the orchestrator, so that no human confirmation prompts block automation.
15. As an orchestrator user, I want the orchestrator to reuse the existing PR plan parser when an epic's plan is approved, so that implementation uses the same battle-tested path.
16. As an orchestrator user, I want the TUI to visually distinguish pipeline stages (pre-implementation vs implementation vs done), so that I can quickly scan overall progress.
17. As an orchestrator user, I want rejected/deferred epics to remain visible but inactive, so that I can revisit them later.
18. As an orchestrator user, I want the orchestrator to handle worker failures during issue creation or plan generation with the same retry logic used for coding workers, so that transient failures don't stall the pipeline.
19. As an orchestrator user, I want the status file to record which gate (PRD or PR plan) an epic is waiting at, so that resume after restart brings me back to the correct approval point.
20. As an orchestrator user, I want the `orchestrator status` CLI command to show epics and their pipeline stages alongside PR group statuses, so that I can inspect state without launching the TUI.

## Implementation Decisions

### Three-Session Model

The full pipeline has three sessions with a natural boundary:

- **Session 1 (manual, outside orchestrator):** `/grill-me` → `/to-prd` — human-driven creative work producing a PRD markdown file and a GitHub epic issue. Deeply coupled skills that require interactive conversation.
- **Session 2 (automated by orchestrator):** `/to-issues` → `/to-pr-plan` — artifact-driven conversion. Worker receives PRD file path and epic issue number. Both skills run non-interactively in a single worker session.
- **Session 3 (automated by orchestrator):** `orchestrator start` equivalent — existing coding-through-merge pipeline picks up from the approved PR plan.

### Epic as Top-Level Entity

Epics are the primary pipeline unit. A single epic produces one PR plan containing multiple PR groups. The hierarchy:

```
Epic (PRD + GitHub issue with `epic` label)
  └── PR Plan (one per epic, parsed by existing parser)
        ├── PR Group 1 → [coding → merge]
        ├── PR Group 2 → [coding → merge]
        └── PR Group N → [coding → merge]
```

### Two Approval Gates

1. **PRD Review** — after epic discovery. User reviews PRD doc in editor, approves in TUI. Triggers Session 2.
2. **PR Plan Review** — after Session 2 completes. User reviews PR plan doc and GitHub issues in editor, approves in TUI. Triggers Session 3 (enters implementation queue).

### Sequential Epic Implementation

Only one epic occupies the implementation pipeline at a time. This prevents:
- Excessive worktrees from unrelated features
- Merge conflicts from divergent branches
- Muddled PR review state

Pre-implementation stages (discovery, PRD review, issue/plan creation, plan review) run concurrently across multiple epics.

### Epic Discovery via GitHub Label

The orchestrator polls GitHub for issues labeled `epic` at a configurable interval. Discovered epics are matched to local PRD files via:
- PRD frontmatter `epic_issue` field → matches GitHub issue number
- Epic issue body contains PRD doc path → bidirectional link

New discoveries appear in TUI as `prd-review` status, awaiting approval.

### Extended Status Lifecycle

The `GroupStep` type expands to include pre-implementation steps:

```
discovered → prd-review → issues-creating → plan-creating → plan-review → idle → cloning → coding → verifying → reviewing → pr-creating → pr-reviewing → awaiting-merge
```

Status files track the full lifecycle. Epic-level status wraps group-level statuses.

### Gate Mechanism

TUI-driven with file-backed state:
- Dashboard shows items awaiting review with visual indicator
- User presses `a` to approve selected item
- Approval updates the status file, triggering the next stage
- PR plan file's `**Status:**` field updated from `pending` to `approved` for consistency with parser

### Worker Skill Dispatch

Worker Manager extended to support arbitrary skill invocation, not just `/pick-up`. Session 2 worker receives a prompt like:

```
Read the PRD at <path> (epic #<number>).
Run /to-issues to create GitHub issues.
Then run /to-pr-plan to group issues into a PR plan.
```

Skills must be non-interactive (forked into claude-config repo with confirmation prompts removed).

### Skill Ownership

The `/to-prd`, `/to-issues`, and `/to-pr-plan` skills are copied from the Matt Pocock suite into the `claude-config` repository for orchestrator-specific customization. Enhancements:
- `/to-prd`: Writes `epic_issue` field in PRD frontmatter, adds PRD doc path to epic issue body
- `/to-issues`: Non-interactive mode, no confirmation prompts
- `/to-pr-plan`: Non-interactive mode, no confirmation prompts

Upstream updates from the Matt Pocock suite are no longer consumed.

## Testing Decisions

Tests should verify external behavior — given inputs, assert outputs and side effects. Do not test internal state transitions or private methods. Prior art: existing test suites in the codebase (515 tests) use vitest with mocked filesystem, git commands, and subprocess spawns.

### Modules to Test

- **Epic Manager** — discovery polling, epic lifecycle transitions, queue ordering, approval state changes. Mock GitHub API responses and filesystem.
- **Pipeline Executor** — worker spawn with correct prompt, status transitions on success/failure, retry on transient errors. Mock Worker Manager.
- **Approval Gate** — pending item enumeration, approve/reject state changes, gate-to-stage transition triggering. Mock Status Manager.
- **Status Manager extensions** — new step values serialize/deserialize correctly, epic-level status wraps group statuses, resume reconciliation handles new states.
- **Scheduler extensions** — epic queue ordering, only active epic enters implementation, queue advances after epic completes.
- **TUI extensions** — epic panel renders, approval keybinding triggers correct action, stage indicators display correctly. Use ink-testing-library snapshot tests.

### Not Tested Directly

- Skill behavior (`/to-issues`, `/to-pr-plan`) — these are external Claude Code skills, not orchestrator code. Orchestrator tests verify correct prompt construction and worker lifecycle.
- GitHub label creation — one-time setup, verified manually.

## Out of Scope

- **Session 1 automation** — `/grill-me` + `/to-prd` stays manual and outside the orchestrator
- **Concurrent epic implementation** — too many edge cases with worktree conflicts and merge chaos; deferred
- **Automatic epic prioritization** — user controls queue order via approval sequence
- **Multi-repo orchestration** — single project only
- **Cost tracking** — not part of pipeline extension
- **Web UI** — TUI remains the sole interface
- **Dry-run mode** — useful but separate concern
- **Skill forking implementation** — the actual skill modifications in claude-config are a separate task tracked outside this PRD

## Further Notes

### Relationship to Existing System

This PRD extends the orchestrator — it does not replace any existing functionality. All 7 current stages (cloning → awaiting-merge) remain unchanged. The extension adds stages before `idle` and wraps the existing pipeline in an epic container.

### Prerequisite: Long-running orchestrator mode

This PRD implicitly requires a long-running orchestrator, but does not explicitly design the event loop. The current orchestrator is one-shot: `assignWork()` in `scheduler.ts` processes all ready groups via `Promise.allSettled()` and returns when all complete or escalate. This is incompatible with:

- **Epic discovery polling** (`epic_poll_interval: 60s`) — requires a persistent process
- **Approval gates** (`prd-review`, `plan-review`) — requires the orchestrator to wait for human input
- **Implementation queue** — requires the orchestrator to detect when one epic finishes and start the next
- **`needs-input` response** — the first-run fixes PRD (PR 5) uses `orchestrator respond` as a stopgap because the orchestrator exits after escalation

A long-running event loop must be designed before this PRD can be implemented. This should be its own design/grill-me session. The event loop would unify: epic polling, approval gate waiting, `needs-input` human response, and implementation queue advancement into a single mechanism.

**Blocker:** Do not start upstream pipeline implementation until long-running orchestrator mode is designed and implemented.

### Future Iteration

After using this pipeline end-to-end, a follow-up grill-me session should capture friction points and inform a second iteration PRD — similar to how the session workflow journal informed this design.

### Config Extensions

The `.orchestrator/config.json` may need new fields:

- `epic_poll_interval` — how often to check GitHub for new epics (default: 60s)
- `skills.to_issues` — path or name of the issues skill
- `skills.to_pr_plan` — path or name of the PR plan skill

### Pipeline State File Structure

```
.orchestrator/
├── epics/
│   └── <epic-slug>.json          # epic lifecycle state
├── status/
│   └── <pr-group-slug>.json      # existing group state (unchanged)
├── context/                       # existing (unchanged)
└── logs/                          # existing (unchanged)
```

Epic state file contains: epic issue number, PRD doc path, PR plan doc path (once created), pipeline stage, approval timestamps, linked PR group slugs.
