import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	Finding,
	FindingSeverity,
	GroupStatus,
	NdjsonResultMessage,
	OrchestratorConfig,
	ReviewResult,
	SelfReviewDeps,
	WorkerEvent,
} from './types.js';

const VALID_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
	'critical',
	'high',
	'medium',
	'low',
]);

// --- Prompt builders ---

export function buildReviewPrompt(
	baseBranch: string,
	branch: string,
	ruleFileContents: readonly string[],
): string {
	const rulesSection =
		ruleFileContents.length > 0
			? `\n\n## Rule Files\n\n${ruleFileContents.map((content, i) => `### Rule file ${i + 1}\n\n${content}`).join('\n\n')}`
			: '';

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
	const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

	const items = blocking
		.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.file}: ${f.description}`)
		.join('\n');

	return `Fix the following code review findings and commit each fix:\n\n${items}`;
}

// --- Parsing ---

export function parseFindings(output: string): readonly Finding[] {
	// Find all candidate JSON array blocks and return first that parses successfully.
	// Uses a non-greedy match to avoid spanning across multiple arrays.
	const candidates: string[] = [...(output.match(/\[[^[]*?\]/g) ?? [])];

	// Also try a greedy match for multi-object arrays (contains nested objects but no nested arrays)
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

		const findings = parsed.filter(
			(item): item is Finding =>
				typeof item === 'object' &&
				item !== null &&
				typeof (item as Record<string, unknown>).severity === 'string' &&
				VALID_SEVERITIES.has((item as Record<string, unknown>).severity as string) &&
				typeof (item as Record<string, unknown>).file === 'string' &&
				typeof (item as Record<string, unknown>).description === 'string',
		);

		if (findings.length > 0) return findings;
	}

	// Check if output contains an empty array
	if (/\[\s*\]/.test(output)) return [];

	return [];
}

export function hasBlockingFindings(findings: readonly Finding[]): boolean {
	return findings.some((f) => f.severity === 'critical' || f.severity === 'high');
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
				// File doesn't exist — skip
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
	// Escape regex metacharacters except *, then convert glob syntax
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
		// Update status
		deps.writeGroupStatus(groupSlug, {
			...currentStatus,
			step: 'reviewing',
			step_result: `review cycle ${cycle}`,
			last_updated: now(),
		});

		// Resolve rule file paths/globs to contents from worktree
		const ruleContents = resolveRuleFileContents(config.rule_files, worktreePath);
		const reviewPrompt = buildReviewPrompt(config.base_branch, currentStatus.branch, ruleContents);

		// Spawn reviewer and capture result
		const reviewCapture = await spawnAndCapture(
			contextKey,
			groupSlug,
			worktreePath,
			reviewPrompt,
			deps,
		);

		if (reviewCapture.exitCode !== 0) {
			// Reviewer crashed — treat as unresolvable
			return { findings: [], approved: false, cycle };
		}

		// Parse findings from reviewer output (null/empty result → no findings)
		const findings = reviewCapture.resultText ? parseFindings(reviewCapture.resultText) : [];

		if (!hasBlockingFindings(findings)) {
			return { findings, approved: true, cycle };
		}

		// Last cycle — can't fix, return unapproved
		if (cycle === maxCycles) {
			return { findings, approved: false, cycle };
		}

		// Spawn fix worker
		const fixPrompt = buildFixPrompt(findings);
		const fixExitCode = await spawnAndWaitForExit(
			`fix-${groupSlug}`,
			groupSlug,
			worktreePath,
			fixPrompt,
			deps,
		);

		if (fixExitCode !== 0) {
			// Fix worker failed — append context and continue to next cycle
			appendReviewContext(deps, groupSlug, cycle, `fix worker exited with code ${fixExitCode}`);
			continue;
		}

		// Run verification after fix
		const verifyResult = await deps.verify(worktreePath, config.verify);
		if (!verifyResult.success) {
			appendReviewContext(
				deps,
				groupSlug,
				cycle,
				`verification failed: ${verifyResult.failedStep}${verifyResult.error ? `\n\n${verifyResult.error}` : ''}`,
			);
			continue;
		}

		// Append review findings as context for next review cycle
		const findingsSummary = findings
			.filter((f) => f.severity === 'critical' || f.severity === 'high')
			.map((f) => `- [${f.severity}] ${f.file}: ${f.description}`)
			.join('\n');
		appendReviewContext(deps, groupSlug, cycle, `findings addressed:\n${findingsSummary}`);
	}

	// Should not reach here due to return in loop, but satisfy compiler
	return { findings: [], approved: false, cycle: maxCycles };
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
	deps: SelfReviewDeps,
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
	deps: SelfReviewDeps,
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

function appendReviewContext(
	deps: SelfReviewDeps,
	groupSlug: string,
	cycle: number,
	detail: string,
): void {
	const key = reviewContextKey(groupSlug);
	const existing = deps.readContext(groupSlug, key) ?? '';
	const entry = `## Review cycle ${cycle}\n\n${detail}\n`;
	const updated = existing ? `${existing}\n${entry}` : entry;
	deps.writeContext(groupSlug, key, updated);
}
