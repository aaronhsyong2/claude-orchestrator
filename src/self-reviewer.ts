import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendReviewContext,
	buildRulesSection,
	isBlocking,
	parseJsonArray,
	spawnAndCapture,
	spawnAndWaitForExit,
	VALID_SEVERITIES,
} from './review-helpers.js';
import type {
	Finding,
	GroupStatus,
	OrchestratorConfig,
	ReviewResult,
	SelfReviewDeps,
} from './types.js';

// --- Prompt builders ---

export function buildReviewPrompt(
	baseBranch: string,
	branch: string,
	ruleFileContents: readonly string[],
): string {
	const rulesSection = buildRulesSection(ruleFileContents);

	return `You are a code reviewer. Review the diff between \`${baseBranch}\` and \`${branch}\`.

Run: git diff ${baseBranch}...${branch}

## Classification Rubric

- **critical**: Security vulnerabilities, data loss, breaking production
- **high**: Correctness bugs, broken functionality, missing error handling
- **medium**: Performance issues, style violations, poor naming
- **low**: Nits, formatting, minor suggestions${rulesSection}

## Output Format

Output ONLY a JSON array of findings. No prose before or after.

\`\`\`json
[{"severity": "critical|high|medium|low", "file": "path/to/file.ts", "description": "what is wrong"}]
\`\`\`

If no issues found, output an empty array: \`[]\``;
}

export function buildFixPrompt(findings: readonly Finding[]): string {
	const blocking = findings.filter((f) => isBlocking(f.severity));

	const items = blocking
		.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.file}: ${f.description}`)
		.join('\n');

	return `Fix the following code review findings and commit each fix:\n\n${items}`;
}

// --- Parsing ---

function isValidFinding(item: unknown): item is Finding {
	return (
		typeof item === 'object' &&
		item !== null &&
		typeof (item as Record<string, unknown>).severity === 'string' &&
		VALID_SEVERITIES.has((item as Record<string, unknown>).severity as string) &&
		typeof (item as Record<string, unknown>).file === 'string' &&
		typeof (item as Record<string, unknown>).description === 'string'
	);
}

export function parseFindings(output: string): readonly Finding[] {
	return parseJsonArray<Finding>(output, isValidFinding);
}

export function hasBlockingFindings(findings: readonly Finding[]): boolean {
	return findings.some((f) => isBlocking(f.severity));
}

// --- Review context key ---

function reviewContextKey(groupSlug: string): string {
	return `review-${groupSlug}`;
}

// --- Rule file resolution ---

const MAX_WALK_DEPTH = 10;
const MAX_WALK_FILES = 1000;

/** Check that a resolved path is contained within the worktree root. */
function isWithinWorktree(resolved: string, worktreePath: string): boolean {
	const root = path.resolve(worktreePath);
	return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Resolve rule file paths/globs to their contents, reading from the worktree. */
export function resolveRuleFileContents(
	ruleFiles: readonly string[],
	worktreePath: string,
): readonly string[] {
	const contents: string[] = [];
	for (const pattern of ruleFiles) {
		if (pattern.includes('*')) {
			const baseParts = pattern.split('*')[0] ?? '';
			const baseDir = path.resolve(worktreePath, baseParts);

			if (!isWithinWorktree(baseDir, worktreePath)) {
				process.stderr.write(
					`[self-reviewer] skipping rule glob "${pattern}" — resolves outside worktree\n`,
				);
				continue;
			}

			try {
				const files = walkDir(baseDir).filter((f) => matchSimpleGlob(f, pattern, worktreePath));
				for (const file of files) {
					try {
						contents.push(fs.readFileSync(file, 'utf-8'));
					} catch {
						process.stderr.write(`[self-reviewer] skipping unreadable rule file: ${file}\n`);
					}
				}
			} catch {
				// Base directory doesn't exist — skip
			}
		} else {
			const filePath = path.resolve(worktreePath, pattern);

			if (!isWithinWorktree(filePath, worktreePath)) {
				process.stderr.write(
					`[self-reviewer] skipping rule file "${pattern}" — resolves outside worktree\n`,
				);
				continue;
			}

			try {
				contents.push(fs.readFileSync(filePath, 'utf-8'));
			} catch {
				process.stderr.write(`[self-reviewer] skipping missing rule file: ${pattern}\n`);
			}
		}
	}
	return contents;
}

function walkDir(dir: string, depth = 0): readonly string[] {
	if (depth > MAX_WALK_DEPTH) return [];
	const results: string[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (results.length >= MAX_WALK_FILES) break;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...walkDir(full, depth + 1));
			} else {
				results.push(full);
			}
		}
	} catch {
		// Directory not accessible
	}
	return results;
}

function matchSimpleGlob(filePath: string, pattern: string, basePath: string): boolean {
	const relative = path.relative(basePath, filePath);
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*');
	try {
		return new RegExp(`^${regexStr}$`).test(relative);
	} catch {
		return false;
	}
}

// --- Main review loop ---

export async function selfReview(
	groupSlug: string,
	worktreePath: string,
	currentStatus: GroupStatus,
	config: OrchestratorConfig,
	deps: SelfReviewDeps,
): Promise<ReviewResult> {
	const maxCycles = config.max_review_cycles;
	const now = deps.now ?? (() => new Date().toISOString());
	const contextKey = reviewContextKey(groupSlug);

	for (let cycle = 1; cycle <= maxCycles; cycle++) {
		deps.writeGroupStatus(groupSlug, {
			...currentStatus,
			step: 'reviewing',
			step_result: `review cycle ${cycle}`,
			last_updated: now(),
		});

		const ruleContents = resolveRuleFileContents(config.rule_files, worktreePath);
		const reviewPrompt = buildReviewPrompt(config.base_branch, currentStatus.branch, ruleContents);

		const reviewCapture = await spawnAndCapture(
			contextKey,
			groupSlug,
			worktreePath,
			reviewPrompt,
			deps,
		);

		if (reviewCapture.exitCode !== 0) {
			process.stderr.write(
				`[self-reviewer] review worker exited ${reviewCapture.exitCode} for ${groupSlug} cycle ${cycle}\n`,
			);
			return { findings: [], approved: false, cycle };
		}

		const findings = reviewCapture.resultText ? parseFindings(reviewCapture.resultText) : [];

		if (!hasBlockingFindings(findings)) {
			return { findings, approved: true, cycle };
		}

		if (cycle === maxCycles) {
			return { findings, approved: false, cycle };
		}

		const fixPrompt = buildFixPrompt(findings);
		const fixExitCode = await spawnAndWaitForExit(
			`fix-${groupSlug}`,
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
				'Review',
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
				'Review',
				cycle,
				`verification failed: ${verifyResult.failedStep}${verifyResult.error ? `\n\n${verifyResult.error}` : ''}`,
			);
			// Reset tracked files and remove untracked files the fixer may have added
			await deps.execCommand('git', ['checkout', '--', '.'], worktreePath);
			await deps.execCommand('git', ['clean', '-fd'], worktreePath);
			continue;
		}

		// Stage and commit any changes the fix worker left unstaged/uncommitted
		await deps.execCommand('git', ['add', '-A'], worktreePath);
		const commitResult = await deps.execCommand(
			'git',
			['commit', '-m', `fix: address review findings (cycle ${cycle})`, '--allow-empty'],
			worktreePath,
		);
		if (commitResult.exitCode !== 0) {
			appendReviewContext(
				deps,
				groupSlug,
				contextKey,
				'Review',
				cycle,
				`commit failed: ${commitResult.stderr}`,
			);
			continue;
		}

		const findingsSummary = findings
			.filter((f) => isBlocking(f.severity))
			.map((f) => `- [${f.severity}] ${f.file}: ${f.description}`)
			.join('\n');
		appendReviewContext(
			deps,
			groupSlug,
			contextKey,
			'Review',
			cycle,
			`findings addressed:\n${findingsSummary}`,
		);
	}

	return { findings: [], approved: false, cycle: maxCycles };
}
