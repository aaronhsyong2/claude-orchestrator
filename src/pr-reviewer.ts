import {
	appendReviewContext,
	buildRulesSection,
	isBlocking,
	parseJsonArray,
	spawnAndCapture,
	spawnAndWaitForExit,
	VALID_SEVERITIES,
} from './review-helpers.js';
import { resolveRuleFileContents } from './self-reviewer.js';
import type {
	FindingSeverity,
	GroupStatus,
	OrchestratorConfig,
	PRComment,
	PRReviewDeps,
	PRReviewResult,
} from './types.js';

// --- Prompt builders ---

export function buildPRReviewPrompt(
	prNumber: number,
	ruleContents: readonly string[],
	priorComments: string | null,
): string {
	const rulesSection = buildRulesSection(ruleContents);

	const priorSection = priorComments
		? `\n\n## Prior Review Comments (verify these are addressed)\n\n${priorComments}`
		: '';

	return `You are a PR reviewer. Review the diff for PR #${prNumber}.

Run: gh pr diff ${prNumber}

## Classification Rubric

- **critical**: Security vulnerabilities, data loss, breaking production
- **high**: Correctness bugs, broken functionality, missing error handling
- **medium**: Performance issues, style violations, poor naming
- **low**: Nits, formatting, minor suggestions${rulesSection}${priorSection}

## Output Format

Output ONLY a JSON array of comments. No prose before or after.

\`\`\`json
[{"severity": "critical|high|medium|low", "file": "path/to/file.ts", "line": 10, "body": "description of issue"}]
\`\`\`

If no issues found, output an empty array: \`[]\``;
}

export function buildPRFixPrompt(comments: readonly PRComment[]): string {
	const blocking = comments.filter((c) => isBlocking(c.severity));

	const items = blocking
		.map(
			(c, i) =>
				`${i + 1}. [${c.severity.toUpperCase()}] ${c.file}${c.line ? `:${c.line}` : ''}: ${c.body}`,
		)
		.join('\n');

	return `Fix the following PR review comments and commit each fix:\n\n${items}`;
}

// --- Parsing ---

function isValidPRComment(item: unknown): item is PRComment {
	return (
		typeof item === 'object' &&
		item !== null &&
		typeof (item as Record<string, unknown>).severity === 'string' &&
		VALID_SEVERITIES.has((item as Record<string, unknown>).severity as string) &&
		typeof (item as Record<string, unknown>).file === 'string' &&
		typeof (item as Record<string, unknown>).body === 'string'
	);
}

export function parsePRComments(output: string): readonly PRComment[] {
	const raw = parseJsonArray<PRComment>(output, isValidPRComment);
	return raw.map((c) => ({
		severity: c.severity as FindingSeverity,
		file: c.file,
		line: typeof c.line === 'number' ? c.line : null,
		body: c.body,
	}));
}

export function hasBlockingComments(comments: readonly PRComment[]): boolean {
	return comments.some((c) => isBlocking(c.severity));
}

// --- Context key ---

function prReviewContextKey(groupSlug: string): string {
	return `pr-review-${groupSlug}`;
}

// --- Main review loop ---

export async function prReview(
	prNumber: number,
	groupSlug: string,
	worktreePath: string,
	currentStatus: GroupStatus,
	config: OrchestratorConfig,
	deps: PRReviewDeps,
): Promise<PRReviewResult> {
	const maxCycles = config.max_review_cycles;
	const now = deps.now ?? (() => new Date().toISOString());
	const contextKey = prReviewContextKey(groupSlug);

	for (let cycle = 1; cycle <= maxCycles; cycle++) {
		deps.writeGroupStatus(groupSlug, {
			...currentStatus,
			step: 'pr-reviewing',
			step_result: `PR review cycle ${cycle}`,
			last_updated: now(),
		});

		const ruleContents = resolveRuleFileContents(config.rule_files, worktreePath);
		const priorComments = deps.readContext(groupSlug, contextKey);
		const reviewPrompt = buildPRReviewPrompt(prNumber, ruleContents, priorComments);

		const reviewCapture = await spawnAndCapture(
			contextKey,
			groupSlug,
			worktreePath,
			reviewPrompt,
			deps,
		);

		if (reviewCapture.exitCode !== 0) {
			return { comments: [], approved: false, cycle };
		}

		const comments = reviewCapture.resultText ? parsePRComments(reviewCapture.resultText) : [];

		if (!hasBlockingComments(comments)) {
			return { comments, approved: true, cycle };
		}

		if (cycle === maxCycles) {
			return { comments, approved: false, cycle };
		}

		const fixPrompt = buildPRFixPrompt(comments);
		const fixExitCode = await spawnAndWaitForExit(
			`pr-fix-${groupSlug}`,
			groupSlug,
			worktreePath,
			fixPrompt,
			deps,
		);

		if (fixExitCode !== 0) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'PR Review',
				cycle,
				`fix worker exited with code ${fixExitCode}`,
			);
			// Reset tracked files and remove untracked files the fixer may have added
			await deps.execCommand('git', ['checkout', '--', '.'], worktreePath);
			await deps.execCommand('git', ['clean', '-fd'], worktreePath);
			continue;
		}

		const verifyResult = await deps.verify(worktreePath, config.verify);
		if (!verifyResult.success) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'PR Review',
				cycle,
				`verification failed: ${verifyResult.failedStep}${verifyResult.error ? `\n\n${verifyResult.error}` : ''}`,
			);
			// Reset tracked files and remove untracked files the fixer may have added
			await deps.execCommand('git', ['checkout', '--', '.'], worktreePath);
			await deps.execCommand('git', ['clean', '-fd'], worktreePath);
			continue;
		}

		// Stage all changes (including new files) then commit
		const addResult = await deps.execCommand('git', ['add', '-A'], worktreePath);
		if (addResult.exitCode !== 0) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'PR Review',
				cycle,
				`git add failed: ${addResult.stderr}`,
			);
			continue;
		}

		const commitResult = await deps.execCommand(
			'git',
			['commit', '-m', `fix: address PR review comments (cycle ${cycle})`],
			worktreePath,
		);

		if (commitResult.exitCode !== 0) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'PR Review',
				cycle,
				`commit failed: ${commitResult.stderr}`,
			);
			continue;
		}

		const pushResult = await deps.execCommand('git', ['push'], worktreePath);
		if (pushResult.exitCode !== 0) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'PR Review',
				cycle,
				`push failed: ${pushResult.stderr}`,
			);
			continue;
		}

		const commentsSummary = comments
			.filter((c) => isBlocking(c.severity))
			.map((c) => `- [${c.severity}] ${c.file}: ${c.body}`)
			.join('\n');
		appendReviewContext(
			deps,
			groupSlug,
			contextKey,
			'PR Review',
			cycle,
			`comments addressed:\n${commentsSummary}`,
		);
	}

	return { comments: [], approved: false, cycle: maxCycles };
}
