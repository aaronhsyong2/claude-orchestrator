import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeDefaultConfig } from './config.js';
import {
	create,
	exists,
	getPath,
	getWorktreeDir,
	getWorktreePath,
	remove,
} from './worktree-manager.js';

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, execFileSync: vi.fn() };
});

const execFileSyncMock = vi.mocked(childProcess.execFileSync);

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('getWorktreeDir', () => {
	it('returns .orchestrator/worktrees under baseDir', () => {
		const result = getWorktreeDir('/repo');
		expect(result).toBe(path.resolve('/repo', '.orchestrator/worktrees'));
	});

	it('defaults to cwd when no baseDir', () => {
		const result = getWorktreeDir();
		expect(result).toBe(path.resolve('.', '.orchestrator/worktrees'));
	});
});

describe('getWorktreePath', () => {
	it('derives deterministic slug from branch name', () => {
		const result = getWorktreePath('feat/my-branch', tmpDir);
		expect(result).toBe(path.join(getWorktreeDir(tmpDir), 'feat-my-branch'));
	});

	it('lowercases uppercase characters', () => {
		const result = getWorktreePath('feat/UPPER_Case', tmpDir);
		expect(result).toBe(path.join(getWorktreeDir(tmpDir), 'feat-upper-case'));
	});

	it('replaces dots and underscores with hyphens', () => {
		const result = getWorktreePath('feat/my.branch_name', tmpDir);
		expect(result).toBe(path.join(getWorktreeDir(tmpDir), 'feat-my-branch-name'));
	});

	it('rejects branch names starting with hyphen', () => {
		expect(() => getWorktreePath('-evil', tmpDir)).toThrow(/must not start with a hyphen/);
	});

	it('rejects empty branch names', () => {
		expect(() => getWorktreePath('', tmpDir)).toThrow(/must not be empty/);
	});

	it('handles simple branch names', () => {
		const result = getWorktreePath('main', tmpDir);
		expect(result).toBe(path.join(getWorktreeDir(tmpDir), 'main'));
	});

	it('strips leading and trailing hyphens from slug', () => {
		const result = getWorktreePath('/feat/branch/', tmpDir);
		expect(result).toBe(path.join(getWorktreeDir(tmpDir), 'feat-branch'));
	});

	it('throws on branch name that produces empty slug', () => {
		expect(() => getWorktreePath('///', tmpDir)).toThrow(/produces an empty slug/);
	});

	it('throws on branch name with consecutive dots', () => {
		expect(() => getWorktreePath('a..b', tmpDir)).toThrow(/must not contain consecutive dots/);
	});

	it('documents slug collision: feat/my-branch and feat-my-branch produce same path', () => {
		const path1 = getWorktreePath('feat/my-branch', tmpDir);
		const path2 = getWorktreePath('feat-my-branch', tmpDir);
		expect(path1).toBe(path2);
	});
});

describe('branch name validation', () => {
	it('rejects branch names starting with hyphen in create', () => {
		expect(() => create('-evil', 'main', tmpDir)).toThrow(/must not start with a hyphen/);
	});

	it('rejects base branch names starting with hyphen in create', () => {
		expect(() => create('feat/ok', '-evil', tmpDir)).toThrow(/must not start with a hyphen/);
	});

	it('rejects empty branch names in create', () => {
		expect(() => create('', 'main', tmpDir)).toThrow(/must not be empty/);
	});

	it('rejects branch names starting with hyphen in remove', () => {
		expect(() => remove('-evil', tmpDir)).toThrow(/must not start with a hyphen/);
	});
});

describe('exists', () => {
	it('returns true when worktree directory exists', () => {
		const wtPath = getWorktreePath('feat/test', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		expect(exists('feat/test', tmpDir)).toBe(true);
	});

	it('returns false when worktree directory does not exist', () => {
		expect(exists('feat/nonexistent', tmpDir)).toBe(false);
	});

	it('rejects branch names starting with hyphen', () => {
		expect(() => exists('-evil', tmpDir)).toThrow(/must not start with a hyphen/);
	});

	it('rejects empty branch names', () => {
		expect(() => exists('', tmpDir)).toThrow(/must not be empty/);
	});
});

describe('getPath', () => {
	it('returns path when worktree exists', () => {
		const wtPath = getWorktreePath('feat/test', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		expect(getPath('feat/test', tmpDir)).toBe(wtPath);
	});

	it('returns null when worktree does not exist', () => {
		expect(getPath('feat/nonexistent', tmpDir)).toBeNull();
	});

	it('rejects branch names starting with hyphen', () => {
		expect(() => getPath('-evil', tmpDir)).toThrow(/must not start with a hyphen/);
	});

	it('rejects empty branch names', () => {
		expect(() => getPath('', tmpDir)).toThrow(/must not be empty/);
	});
});

describe('create', () => {
	it('does not read config when explicit baseBranch is provided', () => {
		// No config file in tmpDir — loadConfig would throw if called
		execFileSyncMock.mockReturnValue(Buffer.from(''));
		const expectedPath = getWorktreePath('feat/explicit', tmpDir);

		const result = create('feat/explicit', 'develop', tmpDir);

		expect(result.worktreePath).toBe(expectedPath);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['worktree', 'add', '-b', 'feat/explicit', expectedPath, 'develop'],
			expect.objectContaining({ stdio: 'pipe' }),
		);
	});

	it('calls git worktree add with correct arguments', () => {
		execFileSyncMock.mockReturnValue(Buffer.from(''));

		const result = create('feat/new-branch', 'main', tmpDir);
		const expectedPath = getWorktreePath('feat/new-branch', tmpDir);

		expect(result.branch).toBe('feat/new-branch');
		expect(result.worktreePath).toBe(expectedPath);

		// First call: rev-parse --verify
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['rev-parse', '--verify', 'main'],
			expect.objectContaining({ cwd: path.resolve(tmpDir), stdio: 'pipe' }),
		);

		// Second call: worktree add
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['worktree', 'add', '-b', 'feat/new-branch', expectedPath, 'main'],
			expect.objectContaining({ cwd: path.resolve(tmpDir), stdio: 'pipe' }),
		);
	});

	it('reads base_branch from config when baseBranch omitted', () => {
		writeDefaultConfig(tmpDir);
		execFileSyncMock.mockReturnValue(Buffer.from(''));

		const result = create('feat/config-test', undefined, tmpDir);
		const expectedPath = getWorktreePath('feat/config-test', tmpDir);

		expect(result.worktreePath).toBe(expectedPath);

		// Should use 'main' from default config
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['rev-parse', '--verify', 'main'],
			expect.objectContaining({ stdio: 'pipe' }),
		);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['worktree', 'add', '-b', 'feat/config-test', expectedPath, 'main'],
			expect.objectContaining({ stdio: 'pipe' }),
		);
	});

	it('returns existing path if worktree already exists (resume)', () => {
		const wtPath = getWorktreePath('feat/existing', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		const result = create('feat/existing', 'main', tmpDir);

		expect(result.branch).toBe('feat/existing');
		expect(result.worktreePath).toBe(wtPath);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('returns idempotent result when worktree already exists on disk (TOCTOU)', () => {
		// Simulate: another agent created the worktree between our exists() check and git call
		const wtPath = getWorktreePath('feat/race', tmpDir);
		const err = new Error('Command failed');
		(err as NodeJS.ErrnoException & { stderr: Buffer }).stderr = Buffer.from(
			"fatal: 'feat/race' already exists",
		);
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			// Simulate the directory appearing (created by competing agent)
			fs.mkdirSync(wtPath, { recursive: true });
			throw err;
		});

		const result = create('feat/race', 'main', tmpDir);
		expect(result.branch).toBe('feat/race');
		expect(result.worktreePath).toBe(wtPath);
	});

	it('throws when git says already exists but no directory on disk (branch name collision)', () => {
		const err = new Error('Command failed');
		(err as NodeJS.ErrnoException & { stderr: Buffer }).stderr = Buffer.from(
			"fatal: 'feat/collision' already exists",
		);
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			throw err;
		});

		expect(() => create('feat/collision', 'main', tmpDir)).toThrow(
			/Failed to create worktree.*already exists/,
		);
	});

	it('throws on missing base branch', () => {
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') {
				throw new Error('fatal: Needed a single revision');
			}
			return Buffer.from('');
		});

		expect(() => create('feat/new', 'nonexistent', tmpDir)).toThrow(
			/Base branch "nonexistent" does not exist/,
		);
	});

	it('throws clear error on disk full from stderr', () => {
		const err = new Error('Command failed');
		(err as NodeJS.ErrnoException & { stderr: Buffer }).stderr =
			Buffer.from('No space left on device');
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			throw err;
		});

		expect(() => create('feat/new', 'main', tmpDir)).toThrow(/Disk full/);
	});

	it('throws clear error on disk full from message fallback', () => {
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			throw new Error('No space left on device');
		});

		expect(() => create('feat/new', 'main', tmpDir)).toThrow(/Disk full/);
	});

	it('throws clear error on permission denied', () => {
		const err = new Error('Command failed');
		(err as NodeJS.ErrnoException & { stderr: Buffer }).stderr = Buffer.from('Permission denied');
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			throw err;
		});

		expect(() => create('feat/new', 'main', tmpDir)).toThrow(/Permission denied/);
	});

	it('throws generic error for unknown failures', () => {
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'rev-parse') return Buffer.from('');
			throw new Error('Something unexpected');
		});

		expect(() => create('feat/new', 'main', tmpDir)).toThrow(
			/Failed to create worktree.*Something unexpected/,
		);
	});
});

describe('remove', () => {
	it('calls git worktree remove and git branch -D', () => {
		const wtPath = getWorktreePath('feat/done', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });
		execFileSyncMock.mockReturnValue(Buffer.from(''));

		remove('feat/done', tmpDir);

		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['worktree', 'remove', wtPath, '--force'],
			expect.objectContaining({ cwd: path.resolve(tmpDir), stdio: 'pipe' }),
		);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['branch', '-D', 'feat/done'],
			expect.objectContaining({ cwd: path.resolve(tmpDir), stdio: 'pipe' }),
		);
	});

	it('skips worktree remove if directory does not exist', () => {
		execFileSyncMock.mockReturnValue(Buffer.from(''));

		remove('feat/nonexistent', tmpDir);

		// Should call branch -D but not worktree remove
		expect(execFileSyncMock).not.toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['worktree', 'remove']),
			expect.anything(),
		);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			'git',
			['branch', '-D', 'feat/nonexistent'],
			expect.objectContaining({ stdio: 'pipe' }),
		);
	});

	it('does not throw if branch delete fails when worktree does not exist', () => {
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'branch') {
				throw new Error('error: branch not found');
			}
			return Buffer.from('');
		});

		expect(() => remove('feat/nonexistent', tmpDir)).not.toThrow();
	});

	it('does not throw if branch delete fails after successful worktree remove', () => {
		const wtPath = getWorktreePath('feat/merged', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'worktree') {
				// Simulate git worktree remove succeeding — remove the directory
				fs.rmSync(wtPath, { recursive: true, force: true });
				return Buffer.from('');
			}
			if (argsList[0] === 'branch') {
				throw new Error('error: branch not found');
			}
			return Buffer.from('');
		});

		expect(() => remove('feat/merged', tmpDir)).not.toThrow();
	});

	it('throws if worktree remove fails', () => {
		const wtPath = getWorktreePath('feat/locked', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'worktree') {
				throw new Error('fatal: cannot remove');
			}
			return Buffer.from('');
		});

		expect(() => remove('feat/locked', tmpDir)).toThrow(/Failed to remove worktree/);
	});

	it('reads git stderr for error messages', () => {
		const wtPath = getWorktreePath('feat/locked2', tmpDir);
		fs.mkdirSync(wtPath, { recursive: true });

		const err = new Error('Command failed');
		(err as NodeJS.ErrnoException & { stderr: Buffer }).stderr = Buffer.from(
			'fatal: worktree is locked',
		);
		execFileSyncMock.mockImplementation((_cmd, args) => {
			const argsList = args as string[];
			if (argsList[0] === 'worktree') throw err;
			return Buffer.from('');
		});

		expect(() => remove('feat/locked2', tmpDir)).toThrow(/worktree is locked/);
	});
});
