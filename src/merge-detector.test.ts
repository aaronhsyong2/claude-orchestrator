import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePRState, startMergeDetector } from './merge-detector.js';
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
		...overrides,
	};
}

describe('startMergeDetector', () => {
	it('calls onComplete with merged when gh reports MERGED', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async () => ({
				exitCode: 0,
				stdout: '{"state":"MERGED"}',
				stderr: '',
			})),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith('merged');
		handle.stop();
	});

	it('calls onComplete with closed when gh reports CLOSED', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async () => ({
				exitCode: 0,
				stdout: '{"state":"CLOSED"}',
				stderr: '',
			})),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith('closed');
		handle.stop();
	});

	it('polls again when state is OPEN', async () => {
		const onComplete = vi.fn();
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

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(onComplete).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(onComplete).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(onComplete).toHaveBeenCalledWith('merged');
		handle.stop();
	});

	it('transitions to GIT_FALLBACK after 3 consecutive failures', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					return { exitCode: 1, stdout: '', stderr: 'API error' };
				}
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: 'abc123\trefs/heads/feat/test', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// 3 gh failures → transition to GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		// Now polling at git interval (50ms)
		await vi.advanceTimersByTimeAsync(50);

		expect(deps.execCommand).toHaveBeenCalledWith('git', ['fetch', '--prune', 'origin'], '/tmp/wt');
		handle.stop();
	});

	it('detects merge via git fallback (branch deleted + merge-base confirms)', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					return { exitCode: 1, stdout: '', stderr: 'API error' };
				}
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: '', stderr: '' }; // branch gone
				}
				if (cmd === 'git' && args[0] === 'merge-base') {
					return { exitCode: 0, stdout: '', stderr: '' }; // is ancestor → merged
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// 3 gh failures → GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		// git fallback poll — detects merge
		await vi.advanceTimersByTimeAsync(50);

		expect(onComplete).toHaveBeenCalledWith('merged');
		handle.stop();
	});

	it('does NOT report merge when branch deleted but not actually merged', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					return { exitCode: 1, stdout: '', stderr: 'API error' };
				}
				if (cmd === 'git' && args[0] === 'fetch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'ls-remote') {
					return { exitCode: 0, stdout: '', stderr: '' }; // branch gone
				}
				if (cmd === 'git' && args[0] === 'branch') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'git' && args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' }; // NOT ancestor → not merged
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// 3 gh failures → GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		// git fallback poll — branch gone but not merged
		await vi.advanceTimersByTimeAsync(50);

		expect(onComplete).not.toHaveBeenCalled();
		handle.stop();
	});

	it('recovers to GITHUB_POLLING when gh succeeds during fallback', async () => {
		const onComplete = vi.fn();
		let ghCallCount = 0;
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					ghCallCount++;
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

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
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

		// gh succeeded → back on GITHUB_POLLING
		expect(onComplete).not.toHaveBeenCalled();
		handle.stop();
	});

	it('stop() prevents further callbacks', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps();

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		await vi.advanceTimersByTimeAsync(0);

		handle.stop();

		await vi.advanceTimersByTimeAsync(10000);

		expect(onComplete).not.toHaveBeenCalled();
		expect(deps.execCommand).toHaveBeenCalledTimes(1);
	});

	it('calls onComplete with timeout when maxWaitMs expires', async () => {
		const onComplete = vi.fn();
		const deps = createMockDeps(); // always returns OPEN

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
			maxWaitMs: 500,
		});

		await vi.advanceTimersByTimeAsync(0); // initial poll
		expect(onComplete).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(500); // timeout fires
		expect(onComplete).toHaveBeenCalledWith('timeout');
		handle.stop();
	});

	it('counts malformed JSON as consecutive failure', async () => {
		const onComplete = vi.fn();
		let ghCallCount = 0;
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'gh') {
					ghCallCount++;
					// Return malformed JSON with exit code 0
					return { exitCode: 0, stdout: 'not json', stderr: '' };
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

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// 1st malformed response (immediate poll)
		await vi.advanceTimersByTimeAsync(0);
		// 2nd malformed response
		await vi.advanceTimersByTimeAsync(100);
		// 3rd malformed response → triggers transition to GIT_FALLBACK
		await vi.advanceTimersByTimeAsync(100);

		// After 3 malformed JSON, should have made 3 gh calls
		expect(ghCallCount).toBe(3);

		// git fallback poll fires at gitFallbackMs interval
		await vi.advanceTimersByTimeAsync(50);
		expect(deps.execCommand).toHaveBeenCalledWith('git', ['fetch', '--prune', 'origin'], '/tmp/wt');
		handle.stop();
	});

	it('handles poll function throwing without crashing', async () => {
		const onComplete = vi.fn();
		let callCount = 0;
		const deps = createMockDeps({
			execCommand: vi.fn(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error('network timeout');
				}
				return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
			}),
		});

		const handle = startMergeDetector(42, 'feat/test', 'main', '/tmp/wt', onComplete, deps, {
			githubPollMs: 100,
			gitFallbackMs: 50,
			recoveryPollMs: 500,
		});

		// First poll throws
		await vi.advanceTimersByTimeAsync(0);
		expect(onComplete).not.toHaveBeenCalled();

		// Second poll succeeds
		await vi.advanceTimersByTimeAsync(100);
		expect(onComplete).toHaveBeenCalledWith('merged');
		handle.stop();
	});
});

describe('parsePRState', () => {
	it('returns MERGED for merged state', () => {
		expect(parsePRState('{"state":"MERGED"}')).toBe('MERGED');
	});

	it('returns CLOSED for closed state', () => {
		expect(parsePRState('{"state":"CLOSED"}')).toBe('CLOSED');
	});

	it('returns OPEN for open state', () => {
		expect(parsePRState('{"state":"OPEN"}')).toBe('OPEN');
	});

	it('returns null for unknown state', () => {
		expect(parsePRState('{"state":"DRAFT"}')).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		expect(parsePRState('not json')).toBeNull();
	});

	it('returns null for missing state field', () => {
		expect(parsePRState('{}')).toBeNull();
	});
});
