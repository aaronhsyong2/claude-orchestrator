import { describe, expect, it, vi } from 'vitest';
import {
	buildPRFixPrompt,
	buildPRReviewPrompt,
	hasBlockingComments,
	parsePRComments,
	prReview,
} from './pr-reviewer.js';
import type {
	GroupStatus,
	NdjsonResultMessage,
	OrchestratorConfig,
	PRComment,
	PRReviewDeps,
} from './types.js';

// --- Helpers ---

const NOW = '2026-05-03T12:00:00.000Z';

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
		branch: 'feat/pr-review',
		current_issue: null,
		step: 'pr-reviewing',
		step_result: '',
		issues_completed: [10, 11],
		issues_remaining: [],
		last_updated: NOW,
		...overrides,
	};
}

type SpawnFn = PRReviewDeps['spawnDirectWorker'];

function makeReviewerSpawn(resultText: string): SpawnFn {
	return (_issue, _slug, _path, onEvent, _ctx) => {
		Promise.resolve().then(() => {
			const resultMsg: NdjsonResultMessage = {
				type: 'result',
				result: resultText,
				is_error: false,
			};
			onEvent({ event: 'message', data: resultMsg });
			onEvent({ event: 'exited', data: 0 });
		});
		return { id: 'test-review', issue: 'review', groupSlug: 'pr-6', pid: 9999 };
	};
}

function makeSequentialSpawn(
	behaviors: ReadonlyArray<{ type: 'review'; result: string } | { type: 'exit'; code: number }>,
): SpawnFn {
	let callIndex = 0;
	return (_issue, _slug, _path, onEvent, _ctx) => {
		const behavior = behaviors[callIndex++];
		if (!behavior) {
			Promise.resolve().then(() => onEvent({ event: 'exited', data: 1 }));
			return { id: 'test', issue: 'test', groupSlug: 'pr-6', pid: 9999 };
		}

		Promise.resolve().then(() => {
			if (behavior.type === 'review') {
				const resultMsg: NdjsonResultMessage = {
					type: 'result',
					result: behavior.result,
					is_error: false,
				};
				onEvent({ event: 'message', data: resultMsg });
				onEvent({ event: 'exited', data: 0 });
			} else {
				onEvent({ event: 'exited', data: behavior.code });
			}
		});
		return { id: 'test', issue: 'test', groupSlug: 'pr-6', pid: 9999 };
	};
}

function createMockDeps(overrides?: Partial<PRReviewDeps>): PRReviewDeps {
	return {
		spawnWorker: vi.fn(),
		spawnDirectWorker: vi.fn(makeReviewerSpawn('[]')),
		verify: vi.fn(async () => ({ success: true as const, steps: [] })),
		execCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
		readContext: vi.fn(() => null),
		writeContext: vi.fn(),
		writeGroupStatus: vi.fn(),
		notify: vi.fn(async () => {}),
		now: () => NOW,
		...overrides,
	};
}

// --- buildPRReviewPrompt ---

describe('buildPRReviewPrompt', () => {
	it('includes PR number and JSON output format', () => {
		const prompt = buildPRReviewPrompt(42, [], null);
		expect(prompt).toContain('PR #42');
		expect(prompt).toContain('gh pr diff 42');
		expect(prompt).toContain('JSON array');
	});

	it('includes rule file contents', () => {
		const prompt = buildPRReviewPrompt(1, ['No console.log'], null);
		expect(prompt).toContain('No console.log');
	});

	it('includes prior comments when provided', () => {
		const prompt = buildPRReviewPrompt(1, [], 'previous issue: missing type');
		expect(prompt).toContain('previous issue: missing type');
		expect(prompt).toContain('Prior Review Comments');
	});
});

// --- buildPRFixPrompt ---

describe('buildPRFixPrompt', () => {
	it('includes only critical/high comments', () => {
		const comments: readonly PRComment[] = [
			{ severity: 'critical', file: 'a.ts', line: 10, body: 'SQL injection' },
			{ severity: 'low', file: 'b.ts', line: 5, body: 'nit' },
			{ severity: 'high', file: 'c.ts', line: null, body: 'missing validation' },
		];
		const prompt = buildPRFixPrompt(comments);
		expect(prompt).toContain('SQL injection');
		expect(prompt).toContain('missing validation');
		expect(prompt).not.toContain('nit');
	});
});

// --- parsePRComments ---

describe('parsePRComments', () => {
	it('parses valid JSON array', () => {
		const output = '```json\n[{"severity":"high","file":"a.ts","line":10,"body":"bug"}]\n```';
		const comments = parsePRComments(output);
		expect(comments).toEqual([{ severity: 'high', file: 'a.ts', line: 10, body: 'bug' }]);
	});

	it('returns empty for empty array', () => {
		expect(parsePRComments('[]')).toEqual([]);
	});

	it('handles null line gracefully', () => {
		const output = '[{"severity":"medium","file":"b.ts","body":"style issue"}]';
		const comments = parsePRComments(output);
		expect(comments).toEqual([
			{ severity: 'medium', file: 'b.ts', line: null, body: 'style issue' },
		]);
	});

	it('returns empty for malformed output', () => {
		expect(parsePRComments('no json here')).toEqual([]);
	});
});

// --- hasBlockingComments ---

describe('hasBlockingComments', () => {
	it('returns true for critical', () => {
		expect(hasBlockingComments([{ severity: 'critical', file: 'a.ts', line: 1, body: 'x' }])).toBe(
			true,
		);
	});

	it('returns true for high', () => {
		expect(hasBlockingComments([{ severity: 'high', file: 'a.ts', line: 1, body: 'x' }])).toBe(
			true,
		);
	});

	it('returns false for medium/low only', () => {
		expect(
			hasBlockingComments([
				{ severity: 'medium', file: 'a.ts', line: 1, body: 'x' },
				{ severity: 'low', file: 'b.ts', line: 2, body: 'y' },
			]),
		).toBe(false);
	});

	it('returns false for empty', () => {
		expect(hasBlockingComments([])).toBe(false);
	});
});

// --- prReview ---

describe('prReview', () => {
	it('approves when no blocking comments on first cycle', async () => {
		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(makeReviewerSpawn('[]')),
		});

		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(1);
	});

	it('approves when only medium/low comments', async () => {
		const output = '[{"severity":"medium","file":"a.ts","line":1,"body":"nit"}]';
		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(makeReviewerSpawn(output)),
		});

		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.comments).toHaveLength(1);
	});

	it('runs fix loop when blocking comments found, then approves', async () => {
		const blockingOutput = '[{"severity":"high","file":"a.ts","line":5,"body":"bug"}]';
		const spawn = makeSequentialSpawn([
			{ type: 'review', result: blockingOutput }, // Cycle 1: reviewer finds issue
			{ type: 'exit', code: 0 }, // Cycle 1: fixer succeeds
			{ type: 'review', result: '[]' }, // Cycle 2: reviewer approves
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });
		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(2);
		// Verify staging + commit was made
		expect(deps.execCommand).toHaveBeenCalledWith('git', ['add', '-A'], '/tmp/wt');
		expect(deps.execCommand).toHaveBeenCalledWith(
			'git',
			['commit', '-m', 'fix: address PR review comments (cycle 1)'],
			'/tmp/wt',
		);
	});

	it('returns unapproved after max cycles exhausted', async () => {
		const blockingOutput = '[{"severity":"critical","file":"a.ts","line":1,"body":"vuln"}]';
		const spawn = makeSequentialSpawn([
			{ type: 'review', result: blockingOutput }, // Cycle 1
			{ type: 'exit', code: 0 }, // Fix 1
			{ type: 'review', result: blockingOutput }, // Cycle 2
			{ type: 'exit', code: 0 }, // Fix 2
			{ type: 'review', result: blockingOutput }, // Cycle 3 (last)
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });
		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(false);
		expect(result.cycle).toBe(3);
	});

	it('continues to next cycle when fix worker fails', async () => {
		const blockingOutput = '[{"severity":"high","file":"a.ts","line":1,"body":"issue"}]';
		const spawn = makeSequentialSpawn([
			{ type: 'review', result: blockingOutput }, // Cycle 1
			{ type: 'exit', code: 1 }, // Fix fails
			{ type: 'review', result: '[]' }, // Cycle 2: approved
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });
		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(2);
	});

	it('returns unapproved when reviewer crashes', async () => {
		const spawn: SpawnFn = (_issue, _slug, _path, onEvent) => {
			Promise.resolve().then(() => onEvent({ event: 'exited', data: 1 }));
			return { id: 'test', issue: 'test', groupSlug: 'pr-6', pid: 9999 };
		};

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });
		const result = await prReview(42, 'pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(false);
		expect(result.cycle).toBe(1);
	});
});
