import { resolveRuleFileContents } from './self-reviewer.js';
import type {
	FindingSeverity,
	GroupStatus,
	NdjsonResultMessage,
	OrchestratorConfig,
	PRComment,
	PRReviewDeps,
	PRReviewResult,
	WorkerEvent,
} from './types.js';

const VALID_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
	'critical',
	'high',
	'medium',
	'low',
]);

// --- Prompt builders ---

export function buildPRReviewPrompt(
	prNumber: number,
	ruleContents: readonly string[],
	priorComments: string | null,
): string {
	const rulesSection =
		ruleContents.length > 0
			? `\n\n## Rule Files\n\n${ruleContents.map((content, i) => `### Rule file ${i + 1}\n\n${content}`).join('\n\n')}`
			: '';

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
	const blocking = comments.filter((c) => c.severity === 'critical' || c.severity === 'high');

	const items = blocking
		.map(
			(c, i) =>
				`${i + 1}. [${c.severity.toUpperCase()}] ${c.file}${c.line ? `:${c.line}` : ''}: ${c.body}`,
		)
		.join('\n');

	return `Fix the following PR review comments and commit each fix:\n\n${items}`;
}

// --- Parsing ---

export function parsePRComments(output: string): readonly PRComment[] {
	const candidates: string[] = [...(output.match(/\[[^[]*?\]/g) ?? [])];

	const greedyMatch = output.match(/\[\s*\{[\s\S]*?\}\s*\]/);
	if (greedyMatch) {
		candidates.unshift(greedyMatch[0]);
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}

		if (!Array.isArray(parsed)) continue;

		const comments = parsed.filter(
			(item): item is PRComment =>
				typeof item === 'object' &&
				item !== null &&
				typeof (item as Record<string, unknown>).severity === 'string' &&
				VALID_SEVERITIES.has((item as Record<string, unknown>).severity as string) &&
				typeof (item as Record<string, unknown>).file === 'string' &&
				typeof (item as Record<string, unknown>).body === 'string',
		);

		if (comments.length > 0) {
			return comments.map((c) => ({
				severity: c.severity,
				file: c.file,
				line: typeof c.line === 'number' ? c.line : null,
				body: c.body,
			}));
		}
	}

	if (/\[\s*\]/.test(output)) return [];

	return [];
}

export function hasBlockingComments(comments: readonly PRComment[]): boolean {
	return comments.some((c) => c.severity === 'critical' || c.severity === 'high');
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
		// Update status
		deps.writeGroupStatus(groupSlug, {
			...currentStatus,
			step: 'pr-reviewing',
			step_result: `PR review cycle ${cycle}`,
			last_updated: now(),
		});

		// Resolve rule file contents
		const ruleContents = resolveRuleFileContents(config.rule_files, worktreePath);
		const priorComments = deps.readContext(groupSlug, contextKey);
		const reviewPrompt = buildPRReviewPrompt(prNumber, ruleContents, priorComments);

		// Spawn reviewer and capture result
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

		// Last cycle — can't fix, return unapproved
		if (cycle === maxCycles) {
			return { comments, approved: false, cycle };
		}

		// Spawn fix worker
		const fixPrompt = buildPRFixPrompt(comments);
		const fixExitCode = await spawnAndWaitForExit(
			`pr-fix-${groupSlug}`,
			groupSlug,
			worktreePath,
			fixPrompt,
			deps,
		);

		if (fixExitCode !== 0) {
			appendPRReviewContext(deps, groupSlug, cycle, `fix worker exited with code ${fixExitCode}`);
			continue;
		}

		// Run verification after fix
		const verifyResult = await deps.verify(worktreePath, config.verify);
		if (!verifyResult.success) {
			appendPRReviewContext(
				deps,
				groupSlug,
				cycle,
				`verification failed: ${verifyResult.failedStep}${verifyResult.error ? `\n\n${verifyResult.error}` : ''}`,
			);
			continue;
		}

		// Commit and push fix
		const commitResult = await deps.execCommand(
			'git',
			['commit', '-am', `fix: address PR review comments (cycle ${cycle})`],
			worktreePath,
		);

		if (commitResult.exitCode !== 0) {
			appendPRReviewContext(deps, groupSlug, cycle, `commit failed: ${commitResult.stderr}`);
			continue;
		}

		const pushResult = await deps.execCommand('git', ['push'], worktreePath);
		if (pushResult.exitCode !== 0) {
			appendPRReviewContext(deps, groupSlug, cycle, `push failed: ${pushResult.stderr}`);
			continue;
		}

		// Append review comments as context for next cycle
		const commentsSummary = comments
			.filter((c) => c.severity === 'critical' || c.severity === 'high')
			.map((c) => `- [${c.severity}] ${c.file}: ${c.body}`)
			.join('\n');
		appendPRReviewContext(deps, groupSlug, cycle, `comments addressed:\n${commentsSummary}`);
	}

	return { comments: [], approved: false, cycle: maxCycles };
}

// --- Helpers ---

interface SpawnCaptureResult {
	readonly exitCode: number;
	readonly resultText: string | null;
}

function spawnAndCapture(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	prompt: string,
	deps: PRReviewDeps,
): Promise<SpawnCaptureResult> {
	return new Promise<SpawnCaptureResult>((resolve, reject) => {
		let resultText: string | null = null;
		try {
			deps.spawnWorker(
				issue,
				groupSlug,
				worktreePath,
				(event: WorkerEvent) => {
					if (event.event === 'message' && event.data.type === 'result') {
						const resultMsg = event.data as NdjsonResultMessage;
						resultText = resultMsg.result;
					}
					if (event.event === 'exited') {
						resolve({ exitCode: event.data, resultText });
					}
					if (event.event === 'error') {
						resolve({ exitCode: 1, resultText: null });
					}
				},
				prompt,
			);
		} catch (err) {
			reject(err);
		}
	});
}

function spawnAndWaitForExit(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	prompt: string,
	deps: PRReviewDeps,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		try {
			deps.spawnWorker(
				issue,
				groupSlug,
				worktreePath,
				(event: WorkerEvent) => {
					if (event.event === 'exited') resolve(event.data);
					if (event.event === 'error') resolve(1);
				},
				prompt,
			);
		} catch (err) {
			reject(err);
		}
	});
}

function appendPRReviewContext(
	deps: PRReviewDeps,
	groupSlug: string,
	cycle: number,
	detail: string,
): void {
	const key = prReviewContextKey(groupSlug);
	const existing = deps.readContext(groupSlug, key) ?? '';
	const entry = `## PR Review cycle ${cycle}\n\n${detail}\n`;
	const updated = existing ? `${existing}\n${entry}` : entry;
	deps.writeContext(groupSlug, key, updated);
}
