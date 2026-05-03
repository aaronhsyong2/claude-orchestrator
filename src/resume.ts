import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGroupStatus, reconcile, writeGroupStatus } from './status-manager.js';
import type { ExecResult, GitBranchState, GroupStatus, ReconcileCorrection } from './types.js';

export interface ResumeResult {
	readonly corrections: readonly ReconcileCorrection[];
	readonly mergedBranches: readonly string[];
	readonly resetGroups: readonly string[];
}

export function hasExistingState(baseDir?: string): boolean {
	const statusDir = path.resolve(baseDir ?? '.', '.orchestrator/status');

	if (!fs.existsSync(statusDir)) {
		return false;
	}

	try {
		const entries = fs.readdirSync(statusDir);
		return entries.some((f) => f.endsWith('.json'));
	} catch (err: unknown) {
		process.stderr.write(`[resume] failed to read status dir: ${String(err)}\n`);
		return false;
	}
}

export async function detectMergedPRs(
	statuses: readonly GroupStatus[],
	execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>,
): Promise<readonly string[]> {
	const merged: string[] = [];

	for (const status of statuses) {
		if (status.step !== 'awaiting-merge') {
			continue;
		}

		try {
			const result = await execCommand(
				'gh',
				['pr', 'list', '--head', status.branch, '--json', 'number,state', '--state', 'merged'],
				'.',
			);

			if (result.exitCode !== 0) {
				process.stderr.write(
					`Warning: gh pr list failed for branch "${status.branch}": ${result.stderr}\n`,
				);
				continue;
			}

			const parsed: unknown = JSON.parse(result.stdout);
			if (Array.isArray(parsed) && parsed.length > 0) {
				merged.push(status.branch);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`Warning: failed to check merged status for branch "${status.branch}": ${message}\n`,
			);
		}
	}

	return merged;
}

export function resetToCheckpoint(
	status: GroupStatus,
	mergedBranches: ReadonlySet<string>,
	now: () => string,
): GroupStatus {
	// All issues complete — reset to idle so scheduler re-enters self-review on next run
	if (
		status.step === 'idle' &&
		status.step_result === 'pass' &&
		status.issues_remaining.length === 0
	) {
		return {
			...status,
			step: 'idle',
			step_result: '',
			current_issue: null,
			last_updated: now(),
		};
	}

	// Died mid-phase (reviewing, pr-creating, pr-reviewing)
	if (
		status.step === 'reviewing' ||
		status.step === 'pr-creating' ||
		status.step === 'pr-reviewing'
	) {
		return {
			...status,
			step: 'idle',
			step_result: '',
			current_issue: null,
			last_updated: now(),
		};
	}

	// PR merged
	if (status.step === 'awaiting-merge' && mergedBranches.has(status.branch)) {
		return {
			...status,
			step: 'idle',
			step_result: 'pass',
			current_issue: null,
			issues_remaining: [],
			last_updated: now(),
		};
	}

	// Awaiting merge but not merged -- keep as-is
	if (status.step === 'awaiting-merge') {
		return status;
	}

	// Died mid-issue (coding, cloning, verifying) -- keep current_issue so it gets retried
	if (status.step === 'coding' || status.step === 'cloning' || status.step === 'verifying') {
		return {
			...status,
			step: 'idle',
			step_result: '',
			last_updated: now(),
		};
	}

	// Graceful shutdown interrupted
	if (status.step === 'idle' && status.step_result === 'interrupted') {
		return {
			...status,
			step: 'idle',
			step_result: '',
			last_updated: now(),
		};
	}

	// Default: return unchanged
	return status;
}

export async function resumeFromState(
	gitState: GitBranchState,
	execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>,
	baseDir?: string,
	now: () => string = () => new Date().toISOString(),
): Promise<ResumeResult> {
	// Step 1: reconcile status files with git state
	const corrections = reconcile(gitState, baseDir, now);

	// Step 2: read all status files
	const statusDir = path.resolve(baseDir ?? '.', '.orchestrator/status');
	const statuses: GroupStatus[] = [];
	const slugs: string[] = [];

	if (fs.existsSync(statusDir)) {
		const files = fs.readdirSync(statusDir).filter((f) => f.endsWith('.json'));
		for (const file of files) {
			const slug = file.replace(/\.json$/, '');
			const status = readGroupStatus(slug, baseDir);
			if (status !== null) {
				statuses.push(status);
				slugs.push(slug);
			}
		}
	}

	// Step 3: detect merged PRs for awaiting-merge groups
	const mergedBranches = await detectMergedPRs(statuses, execCommand);
	const mergedSet: ReadonlySet<string> = new Set(mergedBranches);

	// Step 4: reset each status to safe checkpoint
	const resetGroups: string[] = [];

	for (let i = 0; i < statuses.length; i++) {
		const original = statuses[i];
		const reset = resetToCheckpoint(original, mergedSet, now);

		if (reset !== original) {
			writeGroupStatus(slugs[i], reset, baseDir);
			resetGroups.push(slugs[i]);
		}
	}

	return { corrections, mergedBranches, resetGroups };
}
