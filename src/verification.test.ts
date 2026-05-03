import * as childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyCommand } from './types.js';
import { verify } from './verification.js';

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, execFile: vi.fn() };
});

const execFileMock = vi.mocked(childProcess.execFile);

afterEach(() => {
	vi.resetAllMocks();
});

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockExecFileSequence(
	results: Array<{ exitCode: number; stdout: string; stderr: string }>,
) {
	let callIndex = 0;
	execFileMock.mockImplementation((_file, _args, _opts, callback) => {
		const result = results[callIndex++];
		if (!result) throw new Error('execFile called more times than expected');

		const cb = callback as ExecFileCallback;
		if (result.exitCode === 0) {
			cb(null, result.stdout, result.stderr);
		} else {
			const err = new Error('Command failed') as NodeJS.ErrnoException & {
				status: number;
			};
			err.status = result.exitCode;
			cb(err, result.stdout, result.stderr);
		}

		return {} as childProcess.ChildProcess;
	});
}

const LINT: VerifyCommand = { name: 'lint', command: 'pnpm run check' };
const TYPECHECK: VerifyCommand = { name: 'typecheck', command: 'pnpm run typecheck' };
const BUILD: VerifyCommand = { name: 'build', command: 'pnpm run build' };

describe('verify', () => {
	it('returns success when all commands pass', async () => {
		mockExecFileSequence([
			{ exitCode: 0, stdout: 'ok', stderr: '' },
			{ exitCode: 0, stdout: 'ok', stderr: '' },
			{ exitCode: 0, stdout: 'ok', stderr: '' },
		]);

		const result = await verify('/repo', [LINT, TYPECHECK, BUILD]);

		expect(result.success).toBe(true);
		expect(result.failedStep).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(result.steps).toHaveLength(3);
	});

	it('stops on first failure (fail-fast)', async () => {
		mockExecFileSequence([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 1, stdout: '', stderr: 'type error found' },
		]);

		const result = await verify('/repo', [LINT, TYPECHECK, BUILD]);

		expect(result.success).toBe(false);
		expect(result.failedStep).toBe('typecheck');
		expect(result.error).toBe('type error found');
		expect(result.steps).toHaveLength(2); // BUILD never ran
	});

	it('includes step details', async () => {
		mockExecFileSequence([{ exitCode: 0, stdout: 'lint output', stderr: 'lint warnings' }]);

		const result = await verify('/repo', [LINT]);

		expect(result.steps[0]).toEqual(
			expect.objectContaining({
				name: 'lint',
				command: 'pnpm run check',
				exitCode: 0,
				stdout: 'lint output',
				stderr: 'lint warnings',
			}),
		);
		expect(result.steps[0]?.duration).toBeGreaterThanOrEqual(0);
	});

	it('returns success for empty commands array', async () => {
		const result = await verify('/repo', []);

		expect(result.success).toBe(true);
		expect(result.steps).toHaveLength(0);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('handles command not found error', async () => {
		execFileMock.mockImplementation((_file, _args, _opts, callback) => {
			const err = new Error('Command failed: nonexistent') as NodeJS.ErrnoException & {
				status: number;
			};
			err.code = 'ENOENT';
			err.status = 127;
			(callback as ExecFileCallback)(err, '', 'command not found: nonexistent');
			return {} as childProcess.ChildProcess;
		});

		const result = await verify('/repo', [{ name: 'bad', command: 'nonexistent' }]);

		expect(result.success).toBe(false);
		expect(result.failedStep).toBe('bad');
		expect(result.steps[0]?.exitCode).toBe(127);
		expect(result.steps[0]?.stderr).toContain('command not found');
	});

	it('passes cwd and timeout to execFile', async () => {
		mockExecFileSequence([{ exitCode: 0, stdout: '', stderr: '' }]);

		await verify('/my/worktree', [LINT], 30000);

		expect(execFileMock).toHaveBeenCalledWith(
			'pnpm',
			['run', 'check'],
			expect.objectContaining({ cwd: '/my/worktree', timeout: 30000 }),
			expect.any(Function),
		);
	});

	it('uses default timeout of 5 minutes', async () => {
		mockExecFileSequence([{ exitCode: 0, stdout: '', stderr: '' }]);

		await verify('/repo', [LINT]);

		expect(execFileMock).toHaveBeenCalledWith(
			'pnpm',
			['run', 'check'],
			expect.objectContaining({ timeout: 300000 }),
			expect.any(Function),
		);
	});

	it('executes commands in serial order', async () => {
		const order: string[] = [];
		execFileMock.mockImplementation((file, args, _opts, callback) => {
			order.push(`${file} ${(args as string[]).join(' ')}`);
			(callback as ExecFileCallback)(null, '', '');
			return {} as childProcess.ChildProcess;
		});

		await verify('/repo', [LINT, TYPECHECK, BUILD]);

		expect(order).toEqual(['pnpm run check', 'pnpm run typecheck', 'pnpm run build']);
	});

	it('captures stdout and stderr separately', async () => {
		mockExecFileSequence([{ exitCode: 0, stdout: 'standard output', stderr: 'error output' }]);

		const result = await verify('/repo', [LINT]);

		expect(result.steps[0]?.stdout).toBe('standard output');
		expect(result.steps[0]?.stderr).toBe('error output');
	});

	it('uses stderr as error when available, falls back to stdout', async () => {
		mockExecFileSequence([{ exitCode: 1, stdout: 'stdout fallback', stderr: '' }]);

		const result = await verify('/repo', [LINT]);

		expect(result.error).toBe('stdout fallback');
	});

	it('first command fails immediately', async () => {
		mockExecFileSequence([{ exitCode: 1, stdout: '', stderr: 'lint failed' }]);

		const result = await verify('/repo', [LINT, TYPECHECK, BUILD]);

		expect(result.success).toBe(false);
		expect(result.failedStep).toBe('lint');
		expect(result.steps).toHaveLength(1);
	});

	it('rejects relative cwd', async () => {
		await expect(verify('relative/path', [LINT])).rejects.toThrow(/must be an absolute path/);
	});

	it('rejects empty cwd', async () => {
		await expect(verify('', [LINT])).rejects.toThrow(/must be an absolute path/);
	});

	it('reports timeout with exit code 124', async () => {
		execFileMock.mockImplementation((_file, _args, _opts, callback) => {
			const err = new Error('Command timed out') as NodeJS.ErrnoException & {
				killed: boolean;
			};
			err.killed = true;
			(callback as ExecFileCallback)(err, '', '');
			return {} as childProcess.ChildProcess;
		});

		const result = await verify('/repo', [LINT]);

		expect(result.success).toBe(false);
		expect(result.failedStep).toBe('lint');
		expect(result.steps[0]?.exitCode).toBe(124);
	});

	it('rejects commands with unsafe characters', async () => {
		const unsafe: VerifyCommand = { name: 'evil', command: 'rm -rf /; echo pwned' };

		await expect(verify('/repo', [unsafe])).rejects.toThrow(/unsafe characters/);
	});

	it('rejects shell-delegation executables', async () => {
		const shCmd: VerifyCommand = { name: 'shell', command: 'sh -c echo' };
		const bashCmd: VerifyCommand = { name: 'bash', command: 'bash -c echo' };
		const pythonCmd: VerifyCommand = { name: 'python', command: 'python -c x=1' };
		const envCmd: VerifyCommand = { name: 'env', command: 'env pnpm run test' };

		await expect(verify('/repo', [shCmd])).rejects.toThrow(/shell-delegation executable/);
		await expect(verify('/repo', [bashCmd])).rejects.toThrow(/shell-delegation executable/);
		await expect(verify('/repo', [pythonCmd])).rejects.toThrow(/shell-delegation executable/);
		await expect(verify('/repo', [envCmd])).rejects.toThrow(/shell-delegation executable/);
	});
});
