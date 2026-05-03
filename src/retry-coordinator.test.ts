import { describe, expect, it, vi } from 'vitest';
import {
	classifyFailure,
	executeWithRetry,
	type RetryDeps,
	withBackoff,
} from './retry-coordinator.js';
import type { GroupStatus, OrchestratorConfig, VerifyResult } from './types.js';

describe('classifyFailure', () => {
	it('routes verification failure to retry', () => {
		expect(classifyFailure('failed: lint')).toBe('retry');
		expect(classifyFailure('failed: typecheck')).toBe('retry');
	});

	it('routes worker exit (process crash) to retry', () => {
		expect(classifyFailure('worker exited with code 1')).toBe('retry');
		expect(classifyFailure('worker exited with code 137')).toBe('retry');
	});

	it('routes worker error (spawn failure) to retry', () => {
		expect(classifyFailure('worker error: ENOENT')).toBe('retry');
	});

	it('routes git conflict to immediate needs_input', () => {
		expect(classifyFailure('worktree error: conflict')).toBe('needs_input');
		expect(classifyFailure('worktree error: merge conflict in file.ts')).toBe('needs_input');
	});

	it('routes disk full to immediate needs_input', () => {
		expect(classifyFailure('worktree error: ENOSPC')).toBe('needs_input');
		expect(classifyFailure('worktree error: No space left on device')).toBe('needs_input');
	});

	it('routes generic worktree error to needs_input', () => {
		expect(classifyFailure('worktree error: unknown issue')).toBe('needs_input');
	});
});

// --- Test helpers ---

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
	return {
		base_branch: 'main',
		max_concurrent_agents: 3,
		max_retries_on_fail: 2,
		max_review_cycles: 3,
		verify: [{ name: 'lint', command: 'pnpm run check' }],
		rule_files: [],
		issue_source: { type: 'github', repo: 'org/repo' },
		notifications: { system: true },
		...overrides,
	};
}

function makeStatus(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-6',
		branch: 'feat/resilience',
		current_issue: 15,
		step: 'coding',
		step_result: '',
		issues_completed: [],
		issues_remaining: [15, 16, 17],
		last_updated: '2026-05-03T00:00:00Z',
		...overrides,
	};
}

type SpawnFn = RetryDeps['spawnWorker'];

/** Creates a spawnWorker mock that exits with given codes per call */
function makeSpawnWorker(exitCodes: number[]): SpawnFn {
	let callIndex = 0;
	return (_issue, _slug, _path, onEvent, _ctx) => {
		const code = exitCodes[callIndex++] ?? 0;
		// Simulate async exit
		Promise.resolve().then(() => onEvent({ event: 'exited', data: code }));
		return { id: 'test-1', issue: '15', groupSlug: 'pr-6', pid: 1234 };
	};
}

function makeVerify(results: VerifyResult[]): RetryDeps['verify'] {
	let callIndex = 0;
	return async () => results[callIndex++] ?? { success: true, steps: [] };
}

function makeDeps(overrides?: Partial<RetryDeps>): RetryDeps {
	const contexts = new Map<string, string>();
	return {
		spawnWorker: makeSpawnWorker([0]),
		verify: makeVerify([{ success: true, steps: [] }]),
		readContext: (_slug, issue) => contexts.get(issue) ?? null,
		writeContext: (_slug, issue, content) => {
			contexts.set(issue, content);
		},
		writeGroupStatus: vi.fn(),
		notify: vi.fn(async () => {}),
		...overrides,
	};
}

describe('executeWithRetry', () => {
	it('succeeds on first attempt when worker + verify pass', async () => {
		const deps = makeDeps();
		const result = await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result).toEqual({
			success: true,
			attempts: 1,
			escalated: false,
		});
	});

	it('retries on verification failure and succeeds on second attempt', async () => {
		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([0, 0]),
			verify: makeVerify([
				{ success: false, failedStep: 'lint', error: 'unused var', steps: [] },
				{ success: true, steps: [] },
			]),
		});

		const result = await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result).toEqual({
			success: true,
			attempts: 2,
			escalated: false,
		});
	});

	it('passes accumulated context to retry worker', async () => {
		const spawnCalls: (string | undefined)[] = [];
		const spawnWorker: SpawnFn = (_issue, _slug, _path, onEvent, ctx) => {
			spawnCalls.push(ctx);
			Promise.resolve().then(() => onEvent({ event: 'exited', data: 0 }));
			return { id: 'test-1', issue: '15', groupSlug: 'pr-6', pid: 1234 };
		};

		const deps = makeDeps({
			spawnWorker,
			verify: makeVerify([
				{ success: false, failedStep: 'lint', error: 'unused var x', steps: [] },
				{ success: true, steps: [] },
			]),
		});

		await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		// First call: no context
		expect(spawnCalls[0]).toBeUndefined();
		// Second call: has accumulated context with error details
		expect(spawnCalls[1]).toContain('Attempt 1');
		expect(spawnCalls[1]).toContain('failed: lint');
		expect(spawnCalls[1]).toContain('unused var x');
	});

	it('escalates to NEEDS_INPUT after max retries exhausted', async () => {
		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([0, 0, 0]),
			verify: makeVerify([
				{ success: false, failedStep: 'lint', error: 'err1', steps: [] },
				{ success: false, failedStep: 'lint', error: 'err2', steps: [] },
				{ success: false, failedStep: 'lint', error: 'err3', steps: [] },
			]),
		});

		const status = makeStatus();
		const result = await executeWithRetry(15, 'pr-6', '/tmp/wt', status, makeConfig(), deps);

		expect(result.success).toBe(false);
		expect(result.escalated).toBe(true);
		expect(result.attempts).toBe(3); // 1 initial + 2 retries
		expect(result.escalationReason).toContain('max retries exhausted');

		// Status written with needs-input
		expect(deps.writeGroupStatus).toHaveBeenCalledWith(
			'pr-6',
			expect.objectContaining({ step: 'idle', step_result: 'needs-input' }),
		);

		// Notification sent
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining('#15'),
			expect.objectContaining({ system: true }),
		);
	});

	it('retries on worker crash (non-zero exit) and succeeds', async () => {
		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([1, 0]), // crash then success
			verify: makeVerify([{ success: true, steps: [] }]),
		});

		const result = await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result).toEqual({ success: true, attempts: 2, escalated: false });
	});

	it('escalates after 2 consecutive crashes (retry once, fail on second)', async () => {
		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([1, 1]), // crash twice
			verify: makeVerify([]), // never reached
		});

		const result = await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.success).toBe(false);
		expect(result.escalated).toBe(true);
		expect(result.attempts).toBe(2);
		expect(result.escalationReason).toContain('crashed 2 times consecutively');
		expect(deps.notify).toHaveBeenCalled();
	});

	it('resets crash counter on successful worker exit', async () => {
		// crash → verify fail → crash → escalate (2 consecutive crashes)
		// vs: crash → success+verify fail → crash → no escalate (only 1 consecutive)
		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([1, 0, 1, 0]), // crash, success, crash, success
			verify: makeVerify([
				{ success: false, failedStep: 'lint', error: 'err', steps: [] },
				{ success: false, failedStep: 'lint', error: 'err', steps: [] },
				{ success: true, steps: [] },
			]),
		});

		const result = await executeWithRetry(
			15,
			'pr-6',
			'/tmp/wt',
			makeStatus(),
			makeConfig({ max_retries_on_fail: 4 }),
			deps,
		);

		// Should succeed because crashes are never consecutive
		expect(result.success).toBe(true);
	});

	it('accumulates context across multiple retries', async () => {
		let stored: string | null = null;

		const deps = makeDeps({
			spawnWorker: makeSpawnWorker([0, 0, 0]),
			verify: makeVerify([
				{ success: false, failedStep: 'lint', error: 'error-A', steps: [] },
				{ success: false, failedStep: 'test', error: 'error-B', steps: [] },
				{ success: false, failedStep: 'build', error: 'error-C', steps: [] },
			]),
			readContext: () => stored,
			writeContext: (_slug: string, _issue: string, content: string) => {
				stored = content;
			},
		});

		await executeWithRetry(15, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		// Final context should contain all 3 attempts
		expect(stored).toContain('Attempt 1');
		expect(stored).toContain('Attempt 2');
		expect(stored).toContain('Attempt 3');
		expect(stored).toContain('error-A');
		expect(stored).toContain('error-B');
		expect(stored).toContain('error-C');
	});
});

describe('withBackoff', () => {
	it('succeeds on first attempt', async () => {
		const fn = vi.fn(async () => 'ok');
		const result = await withBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });

		expect(result).toEqual({ success: true, result: 'ok', attempts: 1 });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries on failure and eventually succeeds', async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			if (calls < 3) throw new Error('fail');
			return 'ok';
		};

		const result = await withBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });

		expect(result).toEqual({ success: true, result: 'ok', attempts: 3 });
	});

	it('returns failure after max attempts exhausted', async () => {
		const fn = async () => {
			throw new Error('always fails');
		};

		const result = await withBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });

		expect(result).toEqual({ success: false, attempts: 3 });
	});

	it('applies exponential backoff delays', async () => {
		const timestamps: number[] = [];
		const fn = async () => {
			timestamps.push(Date.now());
			if (timestamps.length < 3) throw new Error('fail');
			return 'ok';
		};

		await withBackoff(fn, { maxAttempts: 3, baseDelayMs: 50 });

		// Second attempt should be ~50ms after first, third ~100ms after second
		const gap1 = timestamps[1] - timestamps[0];
		const gap2 = timestamps[2] - timestamps[1];
		expect(gap1).toBeGreaterThanOrEqual(40); // 50ms base
		expect(gap2).toBeGreaterThanOrEqual(80); // 100ms (2^1 * 50)
	});
});
