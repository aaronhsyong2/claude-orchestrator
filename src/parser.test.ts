import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enrichWithBlockedBy, parseBlockedBy, parsePlan } from './parser.js';
import type { IssueFetcher, PlanData } from './types.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-parser-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePlan(content: string): string {
	const filePath = path.join(tmpDir, 'plan.md');
	fs.writeFileSync(filePath, content);
	return filePath;
}

const FULL_PLAN = `---
title: "Deep Module Refactor — PR Plan"
category: guide
tags:
  - pr-grouping
created: 2026-05-02
updated: 2026-05-02
status: active
---

# Deep Module Refactor — PR Plan

Logical grouping of issues from the deep module refactor.

## PR 1: Type & Import Cleanup

**Branch:** \`refactor/issue-22-24-25\`
**Status:** merged

| Issue | Title | Status |
|-------|-------|--------|
| #22 | Extract inline types | Closed |
| #24 | Fix await import violations | Closed |

## PR 2: Route Extractions

**Branch:** \`refactor/issue-30-33\`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #30 | Extract owners functions | Open |
| #31 | Extract clients functions | Open |

> Depends on: PR 1

## PR 3: API Layer

**Branch:** \`refactor/issue-40-42\`
**Status:** in-progress

| Issue | Title | Status |
|-------|-------|--------|
| #40 | Refactor API routes | Open |

> Depends on: PR 1, PR 2

## Standalone

| Issue | Title | Notes |
|-------|-------|-------|
| #23 | Restructure lib engine | Solo PR |
`;

describe('parsePlan', () => {
	it('parses complete plan with multiple groups', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		expect(result.title).toBe('Deep Module Refactor — PR Plan');
		// 3 PR groups + 1 standalone
		expect(result.groups).toHaveLength(4);
	});

	it('extracts PR group number and title', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		expect(result.groups[0]).toMatchObject({ pr_number: 1, title: 'Type & Import Cleanup' });
		expect(result.groups[1]).toMatchObject({ pr_number: 2, title: 'Route Extractions' });
	});

	it('extracts branch names', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		expect(result.groups[0]?.branch).toBe('refactor/issue-22-24-25');
		expect(result.groups[1]?.branch).toBe('refactor/issue-30-33');
	});

	it('extracts status values', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		expect(result.groups[0]?.status).toBe('merged');
		expect(result.groups[1]?.status).toBe('pending');
		expect(result.groups[2]?.status).toBe('in-progress');
	});

	it('extracts issue references with title, status, and empty blocked_by', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		const group2 = result.groups[1];
		expect(group2?.issues).toHaveLength(2);
		expect(group2?.issues[0]).toEqual({
			number: 30,
			title: 'Extract owners functions',
			status: 'Open',
			blocked_by: [],
		});
		expect(group2?.issues[1]).toEqual({
			number: 31,
			title: 'Extract clients functions',
			status: 'Open',
			blocked_by: [],
		});
	});

	it('parses cross-group dependencies', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		expect(result.groups[1]?.depends_on).toEqual([1]);
		expect(result.groups[2]?.depends_on).toEqual([1, 2]);
	});

	it('parses standalone section as individual groups', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		const standalone = result.groups[3];
		expect(standalone?.pr_number).toBe(0);
		expect(standalone?.title).toBe('Restructure lib engine');
		expect(standalone?.issues).toHaveLength(1);
		expect(standalone?.issues[0]?.number).toBe(23);
	});

	it('handles empty group with heading but no issues', async () => {
		const content = `# Plan

## PR 1: Empty Group

**Branch:** \`feat/empty\`
**Status:** pending
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.issues).toHaveLength(0);
	});

	it('handles missing branch field', async () => {
		const content = `# Plan

## PR 1: No Branch

**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #10 | Some issue | Open |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups[0]?.branch).toBe('');
	});

	it('handles group with no dependencies', async () => {
		const content = `# Plan

## PR 1: Independent

**Branch:** \`feat/solo\`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #1 | Solo task | Open |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups[0]?.depends_on).toEqual([]);
	});

	it('includes done and merged groups in output', async () => {
		const result = await parsePlan(writePlan(FULL_PLAN));
		const statuses = result.groups.map((g) => g.status);
		expect(statuses).toContain('merged');
	});

	it('throws on file not found', async () => {
		await expect(parsePlan('/nonexistent/plan.md')).rejects.toThrow(/Failed to read plan file/);
	});

	it('returns empty groups for markdown with no PR sections', async () => {
		const content = `# Just a Title

Some description with no PR groups.
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups).toHaveLength(0);
		expect(result.title).toBe('Just a Title');
	});

	it('skips table header and separator rows', async () => {
		const content = `# Plan

## PR 1: With Table

**Branch:** \`feat/x\`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #5 | Real issue | Open |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups[0]?.issues).toHaveLength(1);
		expect(result.groups[0]?.issues[0]?.number).toBe(5);
	});

	it('extracts optional route field from PR group', async () => {
		const content = `# Plan

## PR 1: Routed Group

**Branch:** \`feat/routed\`
**Status:** pending
**Route:** \`/tdd\`

| Issue | Title | Status |
|-------|-------|--------|
| #10 | Some task | Open |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups[0]?.route).toBe('/tdd');
	});

	it('leaves route undefined when not specified', async () => {
		const content = `# Plan

## PR 1: No Route

**Branch:** \`feat/no-route\`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #10 | Some task | Open |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups[0]?.route).toBeUndefined();
	});

	it('parses standalone heading case-insensitively', async () => {
		const content = `# Plan

## PR 1: First

**Branch:** \`feat/first\`
**Status:** pending

| Issue | Title | Status |
|-------|-------|--------|
| #1 | First issue | Open |

## standalone

| Issue | Title | Notes |
|-------|-------|-------|
| #99 | Lone wolf | Solo |
`;
		const result = await parsePlan(writePlan(content));
		expect(result.groups).toHaveLength(2);
		expect(result.groups[1]?.pr_number).toBe(0);
		expect(result.groups[1]?.issues[0]?.number).toBe(99);
	});
});

describe('parseBlockedBy', () => {
	it('extracts issue numbers from Blocked by section', () => {
		const body = `## What to build

Some description.

## Blocked by

- #5
- #10

## Acceptance criteria

- Something
`;
		expect(parseBlockedBy(body)).toEqual([5, 10]);
	});

	it('extracts multiple refs on single line', () => {
		const body = `## Blocked by

Depends on #3 and #7 being done first.
`;
		expect(parseBlockedBy(body)).toEqual([3, 7]);
	});

	it('returns empty for no Blocked by section', () => {
		const body = `## What to build

Just a task with no blockers.

## Acceptance criteria

- Done
`;
		expect(parseBlockedBy(body)).toEqual([]);
	});

	it('returns empty for empty Blocked by section', () => {
		const body = `## Blocked by

## Next section
`;
		expect(parseBlockedBy(body)).toEqual([]);
	});

	it('stops at next heading', () => {
		const body = `## Blocked by

- #1

## Acceptance criteria

References #99 but should not be captured.
`;
		expect(parseBlockedBy(body)).toEqual([1]);
	});

	it('handles case-insensitive heading', () => {
		const body = `## blocked by

- #42
`;
		expect(parseBlockedBy(body)).toEqual([42]);
	});
});

describe('enrichWithBlockedBy', () => {
	const basePlan: PlanData = {
		title: 'Test Plan',
		groups: [
			{
				pr_number: 1,
				title: 'Group 1',
				branch: 'feat/g1',
				status: 'pending',
				issues: [
					{ number: 10, title: 'Issue 10', status: 'Open', blocked_by: [] },
					{ number: 11, title: 'Issue 11', status: 'Open', blocked_by: [] },
				],
				depends_on: [],
			},
		],
	};

	it('enriches issues with blocked_by from fetched bodies', async () => {
		const fetcher: IssueFetcher = async (n) => {
			if (n === 10) return '## Blocked by\n\n- #5\n- #6\n';
			return '## What to build\n\nNo blockers.\n';
		};

		const result = await enrichWithBlockedBy(basePlan, fetcher);
		expect(result.groups[0]?.issues[0]?.blocked_by).toEqual([5, 6]);
		expect(result.groups[0]?.issues[1]?.blocked_by).toEqual([]);
	});

	it('preserves issue on fetch failure', async () => {
		const fetcher: IssueFetcher = async () => {
			throw new Error('Network error');
		};

		const result = await enrichWithBlockedBy(basePlan, fetcher);
		expect(result.groups[0]?.issues[0]?.blocked_by).toEqual([]);
		expect(result.groups[0]?.issues).toHaveLength(2);
	});

	it('does not mutate original plan', async () => {
		const fetcher: IssueFetcher = async () => '## Blocked by\n\n- #99\n';

		const result = await enrichWithBlockedBy(basePlan, fetcher);
		expect(result).not.toBe(basePlan);
		expect(result.groups[0]).not.toBe(basePlan.groups[0]);
		expect(basePlan.groups[0]?.issues[0]?.blocked_by).toEqual([]);
	});

	it('handles plan with no issues', async () => {
		const emptyPlan: PlanData = {
			title: 'Empty',
			groups: [
				{
					pr_number: 1,
					title: 'No Issues',
					branch: '',
					status: 'pending',
					issues: [],
					depends_on: [],
				},
			],
		};
		const fetcher: IssueFetcher = async () => '';

		const result = await enrichWithBlockedBy(emptyPlan, fetcher);
		expect(result.groups[0]?.issues).toHaveLength(0);
	});
});
