import * as fs from 'node:fs/promises';
import type { IssueFetcher, IssueRef, PlanData, PRGroup, PRGroupStatus } from './types.js';

const PR_HEADING_RE = /^## PR (\d+): (.+)$/;
const BRANCH_RE = /\*\*Branch:\*\*\s*`([^`]+)`/;
const STATUS_RE = /\*\*Status:\*\*\s*(\w[\w-]*)/;
const ROUTE_RE = /\*\*Route:\*\*\s*`([^`]+)`/;
const ISSUE_REF_RE = /\| #(\d+) \|/;
const DEPENDS_ON_RE = /^>\s*Depends on:\s*(.+)$/;
const STANDALONE_RE = /^## Standalone\s*$/i;
const TITLE_RE = /^# (.+)$/;

const VALID_STATUSES: readonly PRGroupStatus[] = ['pending', 'in-progress', 'done', 'merged'];

function isValidStatus(value: string): value is PRGroupStatus {
	return (VALID_STATUSES as readonly string[]).includes(value);
}

function parseIssueRow(line: string): IssueRef | null {
	const issueMatch = ISSUE_REF_RE.exec(line);
	if (!issueMatch) return null;

	const cells = line
		.split('|')
		.map((c) => c.trim())
		.filter(Boolean);
	if (cells.length < 3) return null;

	return {
		number: Number.parseInt(issueMatch[1], 10),
		title: cells[1],
		status: cells[2],
		blocked_by: [],
	};
}

function parseDependencies(line: string): readonly number[] {
	const match = DEPENDS_ON_RE.exec(line);
	if (!match) return [];

	const refs: number[] = [];
	const prRefs = match[1].matchAll(/PR\s*(\d+)/gi);
	for (const ref of prRefs) {
		refs.push(Number.parseInt(ref[1], 10));
	}
	return refs;
}

export async function parsePlan(filePath: string): Promise<PlanData> {
	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf-8');
	} catch {
		throw new Error(`Failed to read plan file at ${filePath}`);
	}

	const lines = content.split('\n');
	let planTitle = '';
	const groups: PRGroup[] = [];

	let currentGroup: {
		pr_number: number;
		title: string;
		branch: string;
		status: PRGroupStatus;
		issues: IssueRef[];
		depends_on: number[];
		route?: string;
	} | null = null;

	let inStandalone = false;

	for (const line of lines) {
		// Plan title
		const titleMatch = TITLE_RE.exec(line);
		if (titleMatch && !planTitle) {
			planTitle = titleMatch[1];
			continue;
		}

		// PR group heading
		const prMatch = PR_HEADING_RE.exec(line);
		if (prMatch) {
			if (currentGroup) {
				groups.push({ ...currentGroup });
			}
			inStandalone = false;
			currentGroup = {
				pr_number: Number.parseInt(prMatch[1], 10),
				title: prMatch[2],
				branch: '',
				status: 'pending',
				issues: [],
				depends_on: [],
			};
			continue;
		}

		// Standalone heading
		if (STANDALONE_RE.test(line)) {
			if (currentGroup) {
				groups.push({ ...currentGroup });
				currentGroup = null;
			}
			inStandalone = true;
			continue;
		}

		// Branch (within a PR group)
		if (currentGroup) {
			const branchMatch = BRANCH_RE.exec(line);
			if (branchMatch) {
				currentGroup = { ...currentGroup, branch: branchMatch[1] };
				continue;
			}

			const statusMatch = STATUS_RE.exec(line);
			if (statusMatch && isValidStatus(statusMatch[1])) {
				currentGroup = { ...currentGroup, status: statusMatch[1] };
				continue;
			}

			const routeMatch = ROUTE_RE.exec(line);
			if (routeMatch) {
				currentGroup = { ...currentGroup, route: routeMatch[1] };
				continue;
			}

			const issueRef = parseIssueRow(line);
			if (issueRef) {
				currentGroup = { ...currentGroup, issues: [...currentGroup.issues, issueRef] };
				continue;
			}

			const deps = parseDependencies(line);
			if (deps.length > 0) {
				currentGroup = { ...currentGroup, depends_on: [...currentGroup.depends_on, ...deps] };
				continue;
			}
		}

		// Standalone issue rows → individual groups
		if (inStandalone) {
			const issueRef = parseIssueRow(line);
			if (issueRef) {
				groups.push({
					pr_number: 0,
					title: issueRef.title,
					branch: '',
					status: 'pending',
					issues: [issueRef],
					depends_on: [],
				});
			}
		}
	}

	// Push final group
	if (currentGroup) {
		groups.push({ ...currentGroup });
	}

	return { title: planTitle, groups };
}

const BLOCKED_BY_HEADING_RE = /^## Blocked by\s*$/i;

export function parseBlockedBy(issueBody: string): readonly number[] {
	const lines = issueBody.split('\n');
	let inSection = false;
	const refs: number[] = [];

	for (const line of lines) {
		if (BLOCKED_BY_HEADING_RE.test(line)) {
			inSection = true;
			continue;
		}

		if (inSection) {
			if (/^## /.test(line)) break;

			for (const match of line.matchAll(/#(\d+)/g)) {
				refs.push(Number.parseInt(match[1], 10));
			}
		}
	}

	return refs;
}

export async function enrichWithBlockedBy(
	plan: PlanData,
	fetcher: IssueFetcher,
): Promise<PlanData> {
	const enrichedGroups: PRGroup[] = [];

	for (const group of plan.groups) {
		const enrichedIssues = await Promise.all(
			group.issues.map(async (issue) => {
				try {
					const body = await fetcher(issue.number);
					const blocked_by = parseBlockedBy(body);
					return { ...issue, blocked_by };
				} catch {
					return issue;
				}
			}),
		);

		enrichedGroups.push({ ...group, issues: enrichedIssues });
	}

	return { ...plan, groups: enrichedGroups };
}
