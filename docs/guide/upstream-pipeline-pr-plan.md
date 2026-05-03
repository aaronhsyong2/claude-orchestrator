---
title: "Upstream Pipeline — PR Plan"
category: guide
tags:
  - pr-grouping
  - orchestrator
  - epic
  - pipeline
created: 2026-05-04
updated: 2026-05-04
status: active
related:
  - "[Parent Epic: #26](https://github.com/aaronhsyong2/claude-orchestrator/issues/26)"
  - "[PRD](upstream-pipeline-prd.md)"
  - "[Orchestrator PR Plan](claude-orchestrator-pr-plan.md)"
---

# Upstream Pipeline — PR Plan

Logical grouping of issues from the Upstream Pipeline epic (#26) into PRs, ordered by dependency chain.

## PR 1: Epic Foundation — Types, Config, Discovery

**Branch:** `feat/epic-foundation`
**Status:** pending

| Issue | Title | Status |
| ----- | ----- | ------ |
| #28 | Epic status file and lifecycle types | Open |
| #29 | Epic discovery via GitHub epic label polling | Open |

## PR 2: Approval Gates and Pipeline Executor

**Branch:** `feat/epic-pipeline`
**Status:** pending

| Issue | Title | Status |
| ----- | ----- | ------ |
| #30 | PRD approval gate in TUI | Open |
| #31 | Pipeline executor: spawn to-issues and to-pr-plan worker | Open |

> Depends on: PR 1

## PR 3: Implementation Queue and Scheduler Integration

**Branch:** `feat/epic-queue`
**Status:** pending

| Issue | Title | Status |
| ----- | ----- | ------ |
| #32 | PR plan approval gate and implementation queue | Open |

> Depends on: PR 2

## PR 4: TUI Epic Panel and Visualization

**Branch:** `feat/epic-tui`
**Status:** pending

| Issue | Title | Status |
| ----- | ----- | ------ |
| #33 | TUI epic panel, stage visualization, and queue display | Open |

> Depends on: PR 3

## PR 5: Epic Resume and Status Command

**Branch:** `feat/epic-resume`
**Status:** pending

| Issue | Title | Status |
| ----- | ----- | ------ |
| #34 | Epic-aware resume and orchestrator status command | Open |

> Depends on: PR 3
