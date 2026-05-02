---
title: "Claude Orchestrator — PR Plan"
category: guide
tags:
  - pr-grouping
  - orchestrator
created: 2026-05-02
updated: 2026-05-02
status: active
related:
  - "[Parent Epic: #1](https://github.com/aaronhsyong2/claude-orchestrator/issues/1)"
  - "[PRD v2](claude-orchestrator-prd-v2.md)"
  - "[ADR 001](../decisions/001-design-decisions.md)"
---

# Claude Orchestrator — PR Plan

Logical grouping of issues from the Claude Orchestrator epic (#1) into PRs, ordered by dependency chain.

## PR 1: Project Foundation

**Branch:** `feat/project-foundation`
**Status:** merged

| Issue | Title | Status |
|-------|-------|--------|
| #2 | Project scaffold: pnpm + tsup + Biome + vitest + Ink + ESM | Closed |
| #3 | CLI entry: init, start, status subcommands with lock file | Closed |

## PR 2: Core Data Modules

**Branch:** `feat/core-data-modules`
**Status:** merged

| Issue | Title | Status |
|-------|-------|--------|
| #4 | PR Plan Parser: markdown parsing + dependency graph construction | Closed |
| #5 | Status Manager: file-based state CRUD + context file lifecycle | Closed |

> Depends on: PR 1

## PR 3: Infrastructure Modules

**Branch:** `feat/infrastructure-modules`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #6 | Worktree Manager: create/remove worktrees with configurable base branch | Open |
| #7 | Worker Manager: spawn claude -p, parse NDJSON stream, manage lifecycle | Open |
| #8 | Verification Pipeline: serial fail-fast command execution | Open |

> Depends on: PR 2

## PR 4: Scheduler + E2E Integration

**Branch:** `feat/scheduler-e2e-integration`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #9 | Scheduler: dependency-aware work assignment with concurrency cap | Open |
| #10 | End-to-end single PR group flow (console output, no TUI) | Open |

> Depends on: PR 3

## PR 5: TUI Dashboard

**Branch:** `feat/tui-dashboard`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #11 | TUI Dashboard: Lazygit-style layout with PR Groups, Issues, Activity panels | Open |
| #12 | TUI Dashboard: navigation, keybindings, screen modes | Open |
| #13 | Interactive takeover: Ink unmount/remount + neovim integration | Open |
| #14 | Notification Service: TUI badge + macOS system notification | Open |

> Depends on: PR 2

## PR 6: Resilience

**Branch:** `feat/resilience`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #15 | Retry + error escalation: fresh spawn retry with context file | Open |
| #16 | Self-review cycle: severity-gated review with fix loop | Open |
| #17 | PR review + comment fixing + merge detection | Open |

> Depends on: PR 3, PR 5

## PR 7: Shutdown + Resume

**Branch:** `feat/shutdown-resume`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #18 | Graceful shutdown + auto-resume from state + git cross-reference | Open |

> Depends on: PR 4
