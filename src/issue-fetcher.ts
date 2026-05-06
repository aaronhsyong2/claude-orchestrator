import type { ExecResult, IssueContent } from './types.js';

export type { IssueContent } from './types.js';

/**
 * System constraints injected into every worker prompt.
 * Prevents workers from attempting interactive operations or navigating away from worktree.
 */
export const WORKER_CONSTRAINTS = `## System Constraints

- You are in non-interactive mode. MCP tools are unavailable.
- Use \`gh\` CLI for GitHub operations.
- \`gh\` and \`git\` commands work from your worktree directory — do not \`cd\` elsewhere.`;

/**
 * Extract the agent brief from issue comments.
 * Looks for a comment containing an "Agent Brief" heading.
 * Accepts either a JSON string or a parsed array of comments.
 */
export function extractAgentBrief(comments: string | readonly { body?: string }[]): string | null {
	let parsed: Array<{ body?: string }>;
	if (typeof comments === 'string') {
		try {
			parsed = JSON.parse(comments) as Array<{ body?: string }>;
		} catch {
			return null;
		}
	} else {
		parsed = [...comments];
	}

	if (!Array.isArray(parsed)) return null;

	for (const comment of parsed) {
		if (typeof comment.body === 'string' && /^##?\s+Agent Brief/m.test(comment.body)) {
			return comment.body;
		}
	}
	return null;
}

export type ExecCommandFn = (
	cmd: string,
	args: readonly string[],
	cwd: string,
) => Promise<ExecResult>;

/**
 * Pre-fetch issue content using `gh issue view`.
 * Returns null on failure (graceful fallback).
 */
export async function fetchIssueContent(
	issueNumber: number,
	repo: string,
	cwd: string,
	execCommand: ExecCommandFn,
): Promise<IssueContent | null> {
	let result: ExecResult;
	try {
		result = await execCommand(
			'gh',
			['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'title,body,comments'],
			cwd,
		);
	} catch {
		return null;
	}

	if (result.exitCode !== 0) return null;

	let parsed: { title?: string; body?: string; comments?: Array<{ body?: string }> };
	try {
		parsed = JSON.parse(result.stdout) as typeof parsed;
	} catch {
		return null;
	}

	const title = typeof parsed.title === 'string' ? parsed.title : '';
	const body = typeof parsed.body === 'string' ? parsed.body : '';
	const agentBrief = extractAgentBrief(parsed.comments ?? []);

	return { title, body, agentBrief };
}

/**
 * Format pre-fetched issue content into a prompt section.
 */
export function formatIssueContext(content: IssueContent): string {
	const parts = [`## Issue: ${content.title}`, '', content.body];

	if (content.agentBrief) {
		parts.push('', '---', '', content.agentBrief);
	}

	return parts.join('\n');
}
