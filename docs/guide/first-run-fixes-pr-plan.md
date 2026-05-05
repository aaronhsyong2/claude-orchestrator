---
title: "First-Run Fixes — PR Plan"
category: guide
tags:
  - pr-grouping
  - first-run
  - dogfooding
created: 2026-05-04
updated: 2026-05-05
status: active
related:
  - "[Parent Epic: #38](https://github.com/aaronhsyong2/claude-orchestrator/issues/38)"
  - "[First-Run Fixes PRD](first-run-fixes-prd.md)"
  - "[First-Run Issues](first-run-issues.md)"
---

# First-Run Fixes — PR Plan

Logical grouping of issues from the first-run orchestrator fixes (#38) into PRs. Priority order: blockers first, then observability, then worker improvements, then UX.

## PR 1: Test Isolation + Source Runner

**Branch:** `fix/issue-39-40`
**PR:** [#50](https://github.com/aaronhsyong2/claude-orchestrator/pull/50)
**Status:** merged

| Issue | Title | Status |
|-------|-------|--------|
| #39 | Test isolation: all tests use temp baseDir | Closed |
| #40 | cli.test.ts: run from source via tsx instead of dist | Closed |

## PR 2: Observability — Readable Logs + Stuck Detection

**Branch:** `feat/issue-41-42`
**PR:** [#51](https://github.com/aaronhsyong2/claude-orchestrator/pull/51)
**Status:** open (review complete, ready to merge)

| Issue | Title | Status |
|-------|-------|--------|
| #41 | Human-readable worker logs from NDJSON stream | Closed |
| #42 | Stuck detection + elapsed time + live activity in TUI | Closed |

> Depends on: PR 1 (merged)

## PR 3: Session Manager + Session Resume

**Branch:** `feat/issue-43-44`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #43 | Session manager deep module for worker session persistence | Open |
| #44 | Session resume in worker spawns via --session-id + --resume | Open |

## PR 4: Configurable Routing + Pre-fetch + Constraints

**Branch:** `feat/issue-45-46`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #45 | Remove /pick-up from workers, add configurable routing | Open |
| #46 | Pre-fetch issue body + inject system prompt constraints | Open |

## PR 5: Resume CLI Command

**Branch:** `feat/issue-47`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #47 | Add orchestrator resume/run CLI command alias | Open |

## PR 6: Post-Escalation Human Input

**Branch:** `feat/issue-48-49`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #48 | orchestrator respond CLI command for post-escalation input | Open |
| #49 | TUI r key for needs-input response via editor takeover | Open |

> Depends on: PR 3
