import { describe, expect, it, vi } from 'vitest';
import { buildPRBody, pushAndCreatePR } from './pr-creator.js';
import type { PRReviewDeps } from './types.js';

type ExecFn = PRReviewDeps['execCommand'];

describe('pushAndCreatePR', () => {
	it('creates PR when none exists', async () => {
		const execFn = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no PR found' }) // gh pr view
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git push
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'https://github.com/org/repo/pull/42\n',
				stderr: '',
			}); // gh pr create

		const result = await pushAndCreatePR('feat/test', 'main', 'Test PR', 'Body', '/tmp/wt', {
			execCommand: execFn,
		});

		expect(result).toEqual({ prNumber: 42, url: 'https://github.com/org/repo/pull/42' });
		expect(execFn).toHaveBeenCalledTimes(3);
		expect(execFn).toHaveBeenCalledWith(
			'gh',
			['pr', 'view', 'feat/test', '--json', 'number,url'],
			'/tmp/wt',
		);
		expect(execFn).toHaveBeenCalledWith('git', ['push', '-u', 'origin', 'feat/test'], '/tmp/wt');
	});

	it('returns existing PR if one already exists', async () => {
		const execFn = vi.fn<ExecFn>().mockResolvedValueOnce({
			exitCode: 0,
			stdout: '{"number":99,"url":"https://github.com/org/repo/pull/99"}',
			stderr: '',
		});

		const result = await pushAndCreatePR('feat/existing', 'main', 'Title', 'Body', '/tmp/wt', {
			execCommand: execFn,
		});

		expect(result).toEqual({ prNumber: 99, url: 'https://github.com/org/repo/pull/99' });
		expect(execFn).toHaveBeenCalledTimes(1); // Only the view call
	});

	it('throws when git push fails', async () => {
		const execFn = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no PR' }) // gh pr view
			.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'rejected: non-fast-forward' });

		await expect(
			pushAndCreatePR('feat/test', 'main', 'T', 'B', '/tmp/wt', { execCommand: execFn }),
		).rejects.toThrow('git push failed: rejected: non-fast-forward');
	});

	it('throws when gh pr create fails', async () => {
		const execFn = vi
			.fn<ExecFn>()
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no PR' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push ok
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'GraphQL error' });

		await expect(
			pushAndCreatePR('feat/test', 'main', 'T', 'B', '/tmp/wt', { execCommand: execFn }),
		).rejects.toThrow('gh pr create failed: GraphQL error');
	});
});

describe('buildPRBody', () => {
	it('creates body with issue references', () => {
		const body = buildPRBody('Add feature X', [10, 11, 12]);
		expect(body).toContain('Add feature X');
		expect(body).toContain('Closes #10');
		expect(body).toContain('Closes #11');
		expect(body).toContain('Closes #12');
	});

	it('handles empty issues', () => {
		const body = buildPRBody('Refactor', []);
		expect(body).toContain('Refactor');
	});
});
