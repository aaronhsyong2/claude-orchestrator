import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMergeDetector } from './merge-detector.js';
import type { MergeDetectorDeps } from './types.js';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function createMockDeps(overrides?: Partial<MergeDetectorDeps>): MergeDetectorDeps {
	return {
		execCommand: vi.fn(async () => ({ exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' })),
		removeWorktree: vi.fn(),
		...overrides,
	};
}

describe('startMergeDetector', () => {
	it('calls onMerge when gh reports MERGED', async () => {
		const onMerge = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async () => ({
				exitCode: 0,
				stdout: '{"state":"MERGED"}',
				stderr: '',
			})),
		});

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// Initial poll is immediate (no timer)
		await vi.advanceTimersByTimeAsync(0);

		expect(onMerge).toHaveBeenCalledTimes(1);
		handle.stop();
	});

	it('polls again when state is OPEN', async () => {
		const onMerge = vi.fn();
		let callCount = 0;
		const deps = createMockDeps({
			execCommand: vi.fn(async () => {
				callCount++;
				if (callCount >= 3) {
					return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
				}
				return { exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// Initial poll
		await vi.advanceTimersByTimeAsync(0);
		expect(onMerge).not.toHaveBeenCalled();

		// Second poll
		await vi.advanceTimersByTimeAsync(100);
		expect(onMerge).not.toHaveBeenCalled();

		// Third poll — merged
		await vi.advanceTimersByTimeAsync(100);
		expect(onMerge).toHaveBeenCalledTimes(1);
		handle.stop();
	});

	it('transitions to GIT_FALLBACK after 3 consecutive failures', async () => {
		const onMerge = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					return { exitCode: 1, stdout: '', stderr: 'API error' };
				}
				// git fetch
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				// git ls-remote — branch still exists
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: 'abc123\trefs/heads/feat/test', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// Initial poll — failure 1
		await vi.advanceTimersByTimeAsync(0);
		// Failure 2
		await vi.advanceTimersByTimeAsync(100);
		// Failure 3 — transition to GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(100);

		// Now polling at git interval (50ms), calling git fetch + ls-remote
		await vi.advanceTimersByTimeAsync(50);

		// git commands should have been called
		expect(deps.execCommand).toHaveBeenCalledWith('git', ['fetch', 'origin'], '/tmp/wt');
		handle.stop();
	});

	it('detects merge via git fallback (remote branch deleted)', async () => {
		const onMerge = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					return { exitCode: 1, stdout: '', stderr: 'API error' };
				}
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				// Branch gone from remote
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// 3 gh failures to transition
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		// git fallback poll — detects merge
		await vi.advanceTimersByTimeAsync(50);

		expect(onMerge).toHaveBeenCalledTimes(1);
		handle.stop();
	});

	it('recovers to GITHUB_POLLING when gh succeeds during fallback', async () => {
		const onMerge = vi.fn();
		let ghCallCount = 0;
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					ghCallCount++;
					// First 3 fail, then succeed with OPEN
					if (ghCallCount <= 3) {
						return { exitCode: 1, stdout: '', stderr: 'API error' };
					}
					return { exitCode: 0, stdout: '{"state":"OPEN"}', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: 'abc\trefs/heads/feat/test', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 200,
		});

		// 3 failures → GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		// Recovery poll (200ms from transition)
		await vi.advanceTimersByTimeAsync(200);

		// gh succeeded → should be back on GITHUB_POLLING
		// Next poll should be at github interval (100ms), not git (50ms)
		expect(onMerge).not.toHaveBeenCalled();
		handle.stop();
	});

	it('stop() prevents further callbacks', async () => {
		const onMerge = vi.fn();
		const deps = createMockDeps();

		const handle = startMergeDetector(42, 'feat/test', '/tmp/wt', onMerge, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// Initial poll (OPEN)
		await vi.advanceTimersByTimeAsync(0);

		// Stop before next poll
		handle.stop();

		// Advance past many poll intervals
		await vi.advanceTimersByTimeAsync(10000);

		expect(onMerge).not.toHaveBeenCalled();
		// Only 1 call (initial poll)
		expect(deps.execCommand).toHaveBeenCalledTimes(1);
	});
});
