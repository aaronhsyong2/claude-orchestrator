import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { deriveSlug } from './slug.js';
import type { WorktreeInfo } from './types.js';

function getGitErrorMessage(err: unknown): string {
	if (err && typeof err === 'object' && 'stderr' in err) {
		const stderr = (err as { stderr: Buffer | string }).stderr;
		const text = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr);
		if (text.trim()) return text.trim();
	}
	return err instanceof Error ? err.message : String(err);
}

export function getWorktreeDir(baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/worktrees');
}

/**
 * Derives worktree path from branch name using the shared slug derivation.
 *
 * NOTE: Distinct branch names can collide to the same slug (e.g. `feat/my-branch`
 * and `feat-my-branch` both become `feat-my-branch`). Callers of both `create`
 * and `remove` must ensure branch names within a single orchestration run are not
 * slug-equivalent, and must pass the exact branch name used at creation time.
 */
export function getWorktreePath(branch: string, baseDir?: string): string {
	const slug = deriveSlug(branch);
	return path.resolve(baseDir ?? '.', '.orchestrator/worktrees', slug);
}

export function exists(branch: string, baseDir?: string): boolean {
	return fs.existsSync(getWorktreePath(branch, baseDir));
}

export function getPath(branch: string, baseDir?: string): string | null {
	const wtPath = getWorktreePath(branch, baseDir);
	return fs.existsSync(wtPath) ? wtPath : null;
}

export function create(branch: string, baseBranch?: string, baseDir?: string): WorktreeInfo {
	deriveSlug(branch); // validates branch name (empty, leading hyphen)
	const resolvedBase = baseBranch ?? loadConfig(baseDir).base_branch;
	if (!resolvedBase.trim()) {
		throw new Error('Base branch name must not be empty');
	}
	if (resolvedBase.startsWith('-')) {
		throw new Error(`Invalid branch name "${resolvedBase}" — must not start with a hyphen`);
	}

	const wtPath = getWorktreePath(branch, baseDir);
	const repoDir = path.resolve(baseDir ?? '.');

	// If worktree already exists on disk, return existing path
	if (fs.existsSync(wtPath)) {
		return { branch, worktreePath: wtPath };
	}

	// Ensure parent directory exists
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });

	// Verify base branch exists
	try {
		execFileSync('git', ['rev-parse', '--verify', resolvedBase], {
			cwd: repoDir,
			stdio: 'pipe',
		});
	} catch {
		throw new Error(`Base branch "${resolvedBase}" does not exist`);
	}

	try {
		execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, resolvedBase], {
			cwd: repoDir,
			stdio: 'pipe',
		});
	} catch (err: unknown) {
		const message = getGitErrorMessage(err);

		// TOCTOU: another agent may have created the worktree between our check and now.
		// Only return idempotent result if the directory actually exists on disk —
		// "already exists" from git can also mean the branch name exists without a worktree.
		if (message.includes('already exists') && fs.existsSync(wtPath)) {
			return { branch, worktreePath: wtPath };
		}
		if (message.includes('No space left on device') || message.includes('Disk quota exceeded')) {
			throw new Error(`Disk full — cannot create worktree at ${wtPath}`);
		}
		if (message.includes('Permission denied') || message.includes('EACCES')) {
			throw new Error(`Permission denied — cannot create worktree at ${wtPath}`);
		}
		throw new Error(`Failed to create worktree for branch "${branch}": ${message}`);
	}

	return { branch, worktreePath: wtPath };
}

export function remove(branch: string, baseDir?: string): void {
	const wtPath = getWorktreePath(branch, baseDir);
	const repoDir = path.resolve(baseDir ?? '.');

	// Remove worktree via git (if directory exists on disk)
	if (fs.existsSync(wtPath)) {
		try {
			execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
				cwd: repoDir,
				stdio: 'pipe',
			});
		} catch (err: unknown) {
			const message = getGitErrorMessage(err);
			throw new Error(`Failed to remove worktree at ${wtPath}: ${message}`);
		}

		// git worktree remove --force can succeed but leave the directory behind;
		// clean it up if still present
		try {
			if (fs.existsSync(wtPath)) {
				fs.rmSync(wtPath, { recursive: true, force: true });
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`git worktree deregistered but failed to clean up directory at ${wtPath}: ${message}. ` +
					'The directory may need to be removed manually.',
			);
		}
	}

	// Force-delete branch — orchestrator owns these branches and should clean up
	// regardless of merge state. Errors are non-fatal (branch may already be gone).
	try {
		execFileSync('git', ['branch', '-D', branch], {
			cwd: repoDir,
			stdio: 'pipe',
		});
	} catch {
		// Branch may not exist or may already be deleted — not an error
	}
}
