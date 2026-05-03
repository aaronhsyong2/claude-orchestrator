import { describe, expect, it, vi } from 'vitest';
import {
	buildFixPrompt,
	buildReviewPrompt,
	hasBlockingFindings,
	parseFindings,
	selfReview,
} from './self-reviewer.js';
import type {
	Finding,
	GroupStatus,
	NdjsonResultMessage,
	OrchestratorConfig,
	SelfReviewDeps,
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
		branch: 'feat/self-review',
		current_issue: null,
		step: 'reviewing',
		step_result: '',
		issues_completed: [10, 11],
		issues_remaining: [],
		last_updated: NOW,
		...overrides,
	};
}

type SpawnFn = SelfReviewDeps['spawnDirectWorker'];

/** Creates a spawnWorker that emits a result message then exits with code 0. */
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

/** Creates a spawnWorker that cycles through different behaviors per call. */
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

function createMockDeps(overrides?: Partial<SelfReviewDeps>): SelfReviewDeps {
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

// --- buildReviewPrompt ---

describe('buildReviewPrompt', () => {
	it('includes base branch, branch, and JSON output format', () => {
		const prompt = buildReviewPrompt('main', 'feat/test', []);
		expect(prompt).toContain('main');
		expect(prompt).toContain('feat/test');
		expect(prompt).toContain('git diff main...feat/test');
		expect(prompt).toContain('JSON array');
	});

	it('includes rule file contents when provided', () => {
		const rules = ['Rule 1: No console.log', 'Rule 2: Use strict types'];
		const prompt = buildReviewPrompt('main', 'feat/test', rules);
		expect(prompt).toContain('Rule 1: No console.log');
		expect(prompt).toContain('Rule 2: Use strict types');
		expect(prompt).toContain('Rule file 1');
		expect(prompt).toContain('Rule file 2');
	});

	it('omits rule section when no rules provided', () => {
		const prompt = buildReviewPrompt('main', 'feat/test', []);
		expect(prompt).not.toContain('Rule Files');
	});

	it('includes severity classification rubric', () => {
		const prompt = buildReviewPrompt('main', 'feat/test', []);
		expect(prompt).toContain('critical');
		expect(prompt).toContain('high');
		expect(prompt).toContain('medium');
		expect(prompt).toContain('low');
	});
});

// --- parseFindings ---

describe('parseFindings', () => {
	it('parses valid JSON array', () => {
		const input = '[{"severity":"critical","file":"src/a.ts","description":"SQL injection"}]';
		const findings = parseFindings(input);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual({
			severity: 'critical',
			file: 'src/a.ts',
			description: 'SQL injection',
		});
	});

	it('extracts JSON from prose-wrapped output', () => {
		const input = `Here are my findings:\n\n[{"severity":"high","file":"b.ts","description":"bug"}]\n\nThat's all.`;
		const findings = parseFindings(input);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe('high');
	});

	it('returns empty array for malformed output', () => {
		expect(parseFindings('not json at all')).toEqual([]);
	});

	it('returns empty array for empty string', () => {
		expect(parseFindings('')).toEqual([]);
	});

	it('filters out entries with invalid severity', () => {
		const input =
			'[{"severity":"urgent","file":"a.ts","description":"bad"},{"severity":"low","file":"b.ts","description":"ok"}]';
		const findings = parseFindings(input);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe('low');
	});

	it('filters out entries missing required fields', () => {
		const input = '[{"severity":"high"},{"severity":"low","file":"b.ts","description":"ok"}]';
		const findings = parseFindings(input);
		expect(findings).toHaveLength(1);
	});

	it('parses empty JSON array', () => {
		expect(parseFindings('[]')).toEqual([]);
	});
});

// --- hasBlockingFindings ---

describe('hasBlockingFindings', () => {
	it('returns true for critical findings', () => {
		const findings: Finding[] = [{ severity: 'critical', file: 'a.ts', description: 'bad' }];
		expect(hasBlockingFindings(findings)).toBe(true);
	});

	it('returns true for high findings', () => {
		const findings: Finding[] = [{ severity: 'high', file: 'a.ts', description: 'bad' }];
		expect(hasBlockingFindings(findings)).toBe(true);
	});

	it('returns false for medium/low only', () => {
		const findings: Finding[] = [
			{ severity: 'medium', file: 'a.ts', description: 'ok' },
			{ severity: 'low', file: 'b.ts', description: 'nit' },
		];
		expect(hasBlockingFindings(findings)).toBe(false);
	});

	it('returns false for empty array', () => {
		expect(hasBlockingFindings([])).toBe(false);
	});
});

// --- buildFixPrompt ---

describe('buildFixPrompt', () => {
	it('includes only critical and high findings', () => {
		const findings: Finding[] = [
			{ severity: 'critical', file: 'a.ts', description: 'SQL injection' },
			{ severity: 'medium', file: 'b.ts', description: 'naming' },
			{ severity: 'high', file: 'c.ts', description: 'null deref' },
			{ severity: 'low', file: 'd.ts', description: 'nit' },
		];
		const prompt = buildFixPrompt(findings);
		expect(prompt).toContain('SQL injection');
		expect(prompt).toContain('null deref');
		expect(prompt).not.toContain('naming');
		expect(prompt).not.toContain('nit');
	});

	it('formats as numbered list with severity and file', () => {
		const findings: Finding[] = [
			{ severity: 'critical', file: 'src/a.ts', description: 'issue one' },
		];
		const prompt = buildFixPrompt(findings);
		expect(prompt).toContain('1. [CRITICAL] src/a.ts: issue one');
	});
});

// --- selfReview ---

describe('selfReview', () => {
	it('returns approved on clean review (no findings)', async () => {
		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(makeReviewerSpawn('[]')),
		});

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(1);
		expect(result.findings).toEqual([]);
	});

	it('returns approved when only medium/low findings', async () => {
		const findings = '[{"severity":"medium","file":"a.ts","description":"style"}]';
		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(makeReviewerSpawn(findings)),
		});

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(1);
		expect(result.findings).toHaveLength(1);
	});

	it('runs fix loop when critical findings found, approves after clean re-review', async () => {
		const criticalFindings = '[{"severity":"critical","file":"a.ts","description":"bad"}]';
		const cleanFindings = '[]';

		const spawn = makeSequentialSpawn([
			{ type: 'review', result: criticalFindings }, // cycle 1: review finds critical
			{ type: 'exit', code: 0 }, // cycle 1: fix worker succeeds
			{ type: 'review', result: cleanFindings }, // cycle 2: review is clean
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(2);
	});

	it('returns unapproved after max cycles with persistent critical findings', async () => {
		const criticalFindings = '[{"severity":"critical","file":"a.ts","description":"bad"}]';

		const spawn = makeSequentialSpawn([
			{ type: 'review', result: criticalFindings }, // cycle 1: review
			{ type: 'exit', code: 0 }, // cycle 1: fix
			{ type: 'review', result: criticalFindings }, // cycle 2: review
			{ type: 'exit', code: 0 }, // cycle 2: fix
			{ type: 'review', result: criticalFindings }, // cycle 3: review (max)
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(false);
		expect(result.cycle).toBe(3);
		expect(result.findings).toHaveLength(1);
	});

	it('continues to next cycle when verification fails after fix', async () => {
		const criticalFindings = '[{"severity":"high","file":"a.ts","description":"bug"}]';
		const cleanFindings = '[]';
		let verifyCallCount = 0;

		const spawn = makeSequentialSpawn([
			{ type: 'review', result: criticalFindings }, // cycle 1: review
			{ type: 'exit', code: 0 }, // cycle 1: fix
			{ type: 'review', result: cleanFindings }, // cycle 2: review clean
		]);

		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(spawn),
			verify: vi.fn(async () => {
				verifyCallCount++;
				if (verifyCallCount === 1) {
					return { success: false, failedStep: 'lint', error: 'lint error', steps: [] };
				}
				return { success: true, steps: [] };
			}),
		});

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(2);
	});

	it('returns unapproved when reviewer crashes (non-zero exit)', async () => {
		const spawn = makeSequentialSpawn([
			{ type: 'exit', code: 1 }, // reviewer crashes
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(false);
		expect(result.cycle).toBe(1);
	});

	it('updates status at each phase of the loop', async () => {
		const deps = createMockDeps({
			spawnDirectWorker: vi.fn(makeReviewerSpawn('[]')),
		});

		await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(deps.writeGroupStatus).toHaveBeenCalledWith(
			'pr-6',
			expect.objectContaining({
				step: 'reviewing',
				step_result: 'review cycle 1',
			}),
		);
	});

	it('continues when fix worker fails with non-zero exit', async () => {
		const criticalFindings = '[{"severity":"critical","file":"a.ts","description":"bad"}]';
		const cleanFindings = '[]';

		const spawn = makeSequentialSpawn([
			{ type: 'review', result: criticalFindings }, // cycle 1: review
			{ type: 'exit', code: 1 }, // cycle 1: fix fails
			{ type: 'review', result: cleanFindings }, // cycle 2: review clean
		]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), makeConfig(), deps);

		expect(result.approved).toBe(true);
		expect(result.cycle).toBe(2);
	});

	it('respects max_review_cycles config', async () => {
		const criticalFindings = '[{"severity":"critical","file":"a.ts","description":"bad"}]';

		// With max_review_cycles = 1, should return after first review
		const spawn = makeSequentialSpawn([{ type: 'review', result: criticalFindings }]);

		const deps = createMockDeps({ spawnDirectWorker: vi.fn(spawn) });
		const config = makeConfig({ max_review_cycles: 1 });

		const result = await selfReview('pr-6', '/tmp/wt', makeStatus(), config, deps);

		expect(result.approved).toBe(false);
		expect(result.cycle).toBe(1);
	});
});
