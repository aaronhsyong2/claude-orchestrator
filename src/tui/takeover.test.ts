import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TakeoverRequest } from './types.js';

// Mock child_process before importing module
const mockProc = new EventEmitter() as EventEmitter & {
	on: (event: string, cb: (...args: unknown[]) => void) => EventEmitter;
};

const mockSpawn = vi.fn(() => mockProc);

vi.mock('node:child_process', () => ({
	spawn: mockSpawn,
}));

// Import after mock
const { spawnTakeover } = await import('./takeover.js');

const baseRequest: TakeoverRequest = {
	mode: 'shell',
	worktreePath: '/tmp/wt',
	branch: 'feat/test',
};

describe('spawnTakeover', () => {
	beforeEach(() => {
		mockSpawn.mockClear();
		mockProc.removeAllListeners();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('shell mode uses $SHELL env var', async () => {
		vi.stubEnv('SHELL', '/bin/zsh');

		const promise = spawnTakeover({ ...baseRequest, mode: 'shell' });
		mockProc.emit('close', 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith('/bin/zsh', [], expect.any(Object));
	});

	it('falls back to /bin/sh when SHELL is empty string', async () => {
		vi.stubEnv('SHELL', '');

		const promise = spawnTakeover({ ...baseRequest, mode: 'shell' });
		mockProc.emit('close', 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith('/bin/sh', [], expect.any(Object));
	});

	it('falls back to /bin/sh when SHELL is undefined', async () => {
		const origShell = process.env.SHELL;
		delete process.env.SHELL;

		try {
			const promise = spawnTakeover({ ...baseRequest, mode: 'shell' });
			mockProc.emit('close', 0);
			await promise;

			expect(mockSpawn).toHaveBeenCalledWith('/bin/sh', [], expect.any(Object));
		} finally {
			if (origShell !== undefined) process.env.SHELL = origShell;
		}
	});

	it('nvim mode passes worktreePath as arg', async () => {
		const promise = spawnTakeover({ ...baseRequest, mode: 'nvim' });
		mockProc.emit('close', 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith('nvim', ['/tmp/wt'], expect.any(Object));
	});

	it('sets cwd to worktreePath', async () => {
		const promise = spawnTakeover({ ...baseRequest, worktreePath: '/some/path' });
		mockProc.emit('close', 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({ cwd: '/some/path' }),
		);
	});

	it('resolves with exit code on close', async () => {
		const promise = spawnTakeover(baseRequest);
		mockProc.emit('close', 42);
		const code = await promise;

		expect(code).toBe(42);
	});

	it('resolves with 0 when close code is null', async () => {
		const promise = spawnTakeover(baseRequest);
		mockProc.emit('close', null);
		const code = await promise;

		expect(code).toBe(0);
	});

	it('rejects on spawn error', async () => {
		const promise = spawnTakeover(baseRequest);
		mockProc.emit('error', new Error('ENOENT'));

		await expect(promise).rejects.toThrow('Failed to spawn shell: ENOENT');
	});

	it('uses stdio: inherit', async () => {
		const promise = spawnTakeover(baseRequest);
		mockProc.emit('close', 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({ stdio: 'inherit' }),
		);
	});
});
