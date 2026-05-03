import type { PRReviewDeps } from './types.js';

export interface PRCreateResult {
	readonly prNumber: number;
	readonly url: string;
}

export type PRCreatorDeps = Pick<PRReviewDeps, 'execCommand'>;

/** Push branch and create PR via gh CLI. Returns PR number and URL. */
export async function pushAndCreatePR(
	branch: string,
	baseBranch: string,
	title: string,
	body: string,
	worktreePath: string,
	deps: PRCreatorDeps,
): Promise<PRCreateResult> {
	// Check if PR already exists for this branch
	const existing = await deps.execCommand(
		'gh',
		['pr', 'view', branch, '--json', 'number,url'],
		worktreePath,
	);

	if (existing.exitCode === 0 && existing.stdout.trim()) {
		return parsePRViewOutput(existing.stdout);
	}

	// Push branch
	const pushResult = await deps.execCommand('git', ['push', '-u', 'origin', branch], worktreePath);

	if (pushResult.exitCode !== 0) {
		throw new Error(`git push failed: ${pushResult.stderr || pushResult.stdout}`);
	}

	// Create PR
	const createResult = await deps.execCommand(
		'gh',
		['pr', 'create', '--title', title, '--body', body, '--base', baseBranch, '--head', branch],
		worktreePath,
	);

	if (createResult.exitCode !== 0) {
		throw new Error(`gh pr create failed: ${createResult.stderr || createResult.stdout}`);
	}

	return parsePRCreateOutput(createResult.stdout);
}

function parsePRViewOutput(stdout: string): PRCreateResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error(`Could not parse gh pr view JSON: ${stdout.trim().slice(0, 200)}`);
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).number !== 'number' ||
		typeof (parsed as Record<string, unknown>).url !== 'string'
	) {
		throw new Error(`Unexpected gh pr view output: ${stdout.trim().slice(0, 200)}`);
	}
	const obj = parsed as { number: number; url: string };
	return { prNumber: obj.number, url: obj.url };
}

function parsePRCreateOutput(stdout: string): PRCreateResult {
	const url = stdout.trim();
	const match = url.match(/\/pull\/(\d+)/);
	if (!match) {
		throw new Error(`Could not parse PR number from gh output: ${url}`);
	}
	return { prNumber: Number(match[1]), url };
}

/** Build PR body from group metadata. */
export function buildPRBody(groupTitle: string, issuesCompleted: readonly number[]): string {
	const issueRefs = issuesCompleted.map((n) => `- Closes #${n}`).join('\n');
	return `## Summary\n\n${groupTitle}\n\n## Issues\n\n${issueRefs}`;
}
