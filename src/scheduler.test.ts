import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignWork, getReadyGroups, onMerge } from './scheduler.js';
import type {
	GroupStatus,
	NdjsonMessage,
	OrchestratorConfig,
	PlanData,
	PRGroup,
	SchedulerDeps,
	WorkerEventType,
	WorkerHandle,
} from './types.js';

// --- Helpers ---

const NOW = '2026-05-02T12:00:00.000Z';
const now = () => NOW;

const BASE_CONFIG: OrchestratorConfig = {
	base_branch: 'main',
	max_concurrent_agents: 3,
	max_retries_on_fail: 2,
	max_review_cycles: 3,
	verify: [{ name: 'lint', command: 'pnpm run check' }],
	rule_files: [],
	issue_source: { type: 'github', repo: 'org/repo' },
	notifications: { system: false },
};

function makeGroup(overrides: Partial<PRGroup> = {}): PRGroup {
	return {
		pr_number: 1,
		title: 'Test PR',
		branch: 'feat/test',
		status: 'pending',
		issues: [{ number: 10, title: 'Issue 10', status: 'Open', blocked_by: [] }],
		depends_on: [],
		...overrides,
	};
}

function makePlan(groups: readonly PRGroup[]): PlanData {
	return { title: 'Test Plan', groups };
}

function createMockDeps(overrides?: Partial<SchedulerDeps>): SchedulerDeps {
	const statuses = new Map<string, GroupStatus>();
	return {
		createWorktree: vi.fn(() => ({ branch: 'feat/test', worktreePath: '/tmp/wt' })),
		removeWorktree: vi.fn(),
		spawnWorker: vi.fn(
			(
				_issue: string,
				_slug: string,
				_path: string,
				onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
			) => {
				process.nextTick(() => onEvent('exited', 0));
				return { id: 'test-1', issue: '1', groupSlug: 'test', pid: 123 } satisfies WorkerHandle;
			},
		),
		killWorker: vi.fn(async () => {}),
		verify: vi.fn(async () => ({ success: true as const, steps: [] })),
		readGroupStatus: vi.fn((slug: string) => statuses.get(slug) ?? null),
		writeGroupStatus: vi.fn((slug: string, data: GroupStatus) => {
			statuses.set(slug, data);
		}),
		readContext: vi.fn(() => null),
		deleteContext: vi.fn(),
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

// --- getReadyGroups ---

describe('getReadyGroups', () => {
	it('returns groups with no dependencies', () => {
		const groups = [makeGroup({ pr_number: 1, depends_on: [] })];
		const result = getReadyGroups(makePlan(groups), new Set());
		expect(result).toHaveLength(1);
		expect(result[0]?.pr_number).toBe(1);
	});

	it('returns groups with all deps merged', () => {
		const groups = [makeGroup({ pr_number: 2, depends_on: [1] })];
		const result = getReadyGroups(makePlan(groups), new Set([1]));
		expect(result).toHaveLength(1);
	});

	it('excludes groups with unmerged deps', () => {
		const groups = [makeGroup({ pr_number: 2, depends_on: [1] })];
		const result = getReadyGroups(makePlan(groups), new Set());
		expect(result).toHaveLength(0);
	});

	it('handles mixed ready and blocked groups', () => {
		const groups = [
			makeGroup({ pr_number: 1, depends_on: [] }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
			makeGroup({ pr_number: 3, depends_on: [99] }),
		];
		const result = getReadyGroups(makePlan(groups), new Set([1]));
		expect(result).toHaveLength(2);
		expect(result.map((g) => g.pr_number)).toEqual([1, 2]);
	});

	it('excludes done groups', () => {
		const groups = [makeGroup({ pr_number: 1, status: 'done' })];
		const result = getReadyGroups(makePlan(groups), new Set());
		expect(result).toHaveLength(0);
	});

	it('excludes merged groups', () => {
		const groups = [makeGroup({ pr_number: 1, status: 'merged' })];
		const result = getReadyGroups(makePlan(groups), new Set());
		expect(result).toHaveLength(0);
	});

	it('returns empty for empty plan', () => {
		const result = getReadyGroups(makePlan([]), new Set());
		expect(result).toHaveLength(0);
	});

	it('returns in-progress groups that are ready', () => {
		const groups = [makeGroup({ pr_number: 1, status: 'in-progress', depends_on: [] })];
		const result = getReadyGroups(makePlan(groups), new Set());
		expect(result).toHaveLength(1);
	});
});

// --- assignWork ---

describe('assignWork', () => {
	it('processes single group with single issue — success path', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/test' });
		const deps = createMockDeps();

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.assigned).toBe(1);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.completed).toBe(true);
		expect(deps.createWorktree).toHaveBeenCalledWith('feat/test', 'main');
		expect(deps.spawnWorker).toHaveBeenCalled();
		expect(deps.verify).toHaveBeenCalled();
		expect(deps.deleteContext).toHaveBeenCalled();
	});

	it('processes multiple issues in serial order', async () => {
		const spawnOrder: string[] = [];
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/multi',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
				{ number: 12, title: 'Third', status: 'Open', blocked_by: [] },
			],
		});

		const deps = createMockDeps({
			spawnWorker: vi.fn(
				(
					issue: string,
					_slug: string,
					_path: string,
					onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
				) => {
					spawnOrder.push(issue);
					process.nextTick(() => onEvent('exited', 0));
					return { id: `test-${issue}`, issue, groupSlug: 'feat-multi', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(true);
		expect(spawnOrder).toEqual(['10', '11', '12']);
	});

	it('stops on worker failure', async () => {
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/fail',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
			],
		});

		const deps = createMockDeps({
			spawnWorker: vi.fn(
				(
					_issue: string,
					_slug: string,
					_path: string,
					onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
				) => {
					process.nextTick(() => onEvent('exited', 1));
					return { id: 'test-1', issue: '10', groupSlug: 'feat-fail', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.failedIssue).toBe(10);
		expect(result.results[0]?.error).toContain('worker exited with code 1');
		// Second issue should not have been attempted
		expect(deps.spawnWorker).toHaveBeenCalledTimes(1);
	});

	it('stops on verification failure', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/vfail' });
		const deps = createMockDeps({
			verify: vi.fn(async () => ({
				success: false as const,
				failedStep: 'lint',
				error: 'lint errors',
				steps: [],
			})),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('verification failed at step: lint');
	});

	it('sets step to reviewing when all issues complete', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/review' });
		const deps = createMockDeps();

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const lastCall = writeStatusMock.mock.calls[writeStatusMock.mock.calls.length - 1];
		expect(lastCall?.[1].step).toBe('reviewing');
		expect(lastCall?.[1].step_result).toBe('ready for self-review');
	});

	it('respects max_concurrent_agents cap', async () => {
		const groups = [
			makeGroup({ pr_number: 1, branch: 'feat/a' }),
			makeGroup({ pr_number: 2, branch: 'feat/b' }),
			makeGroup({ pr_number: 3, branch: 'feat/c' }),
			makeGroup({ pr_number: 4, branch: 'feat/d' }),
			makeGroup({ pr_number: 5, branch: 'feat/e' }),
		];
		const config = { ...BASE_CONFIG, max_concurrent_agents: 2 };
		const deps = createMockDeps();

		const result = await assignWork(makePlan(groups), new Set(), config, deps, now);

		expect(result.assigned).toBe(2);
		expect(result.results).toHaveLength(2);
	});

	it('handles fewer ready groups than cap', async () => {
		const groups = [makeGroup({ pr_number: 1, branch: 'feat/solo' })];
		const config = { ...BASE_CONFIG, max_concurrent_agents: 5 };
		const deps = createMockDeps();

		const result = await assignWork(makePlan(groups), new Set(), config, deps, now);

		expect(result.assigned).toBe(1);
	});

	it('returns assigned=0 when all groups blocked', async () => {
		const groups = [makeGroup({ pr_number: 2, depends_on: [99] })];
		const deps = createMockDeps();

		const result = await assignWork(makePlan(groups), new Set(), BASE_CONFIG, deps, now);

		expect(result.assigned).toBe(0);
		expect(result.results).toHaveLength(0);
	});

	it('returns assigned=0 for empty plan', async () => {
		const deps = createMockDeps();

		const result = await assignWork(makePlan([]), new Set(), BASE_CONFIG, deps, now);

		expect(result.assigned).toBe(0);
	});

	it('tracks status transitions through lifecycle', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/track' });
		const deps = createMockDeps();

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const steps = writeStatusMock.mock.calls.map((call) => call[1].step);
		// init(idle) → cloning → coding → verifying → idle(pass) → reviewing
		expect(steps).toEqual(['idle', 'cloning', 'coding', 'verifying', 'idle', 'reviewing']);
	});

	it('passes context from previous attempt to worker', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/ctx' });
		const deps = createMockDeps({
			readContext: vi.fn(() => 'Previous attempt failed due to X'),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.spawnWorker).toHaveBeenCalledWith(
			'10',
			expect.any(String),
			'/tmp/wt',
			expect.any(Function),
			'Previous attempt failed due to X',
		);
	});

	it('deletes context on success', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/delctx' });
		const deps = createMockDeps();

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.deleteContext).toHaveBeenCalledWith(expect.any(String), '10');
	});

	it('does not delete context on failure', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/nodel' });
		const deps = createMockDeps({
			spawnWorker: vi.fn(
				(
					_issue: string,
					_slug: string,
					_path: string,
					onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
				) => {
					process.nextTick(() => onEvent('exited', 1));
					return { id: 'test-1', issue: '10', groupSlug: 'test', pid: 123 };
				},
			),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.deleteContext).not.toHaveBeenCalled();
	});

	it('handles createWorktree failure gracefully', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/diskfull' });
		const deps = createMockDeps({
			createWorktree: vi.fn(() => {
				throw new Error('Disk full — cannot create worktree');
			}),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('worktree error: Disk full');
		expect(deps.spawnWorker).not.toHaveBeenCalled();
	});

	it('handles worker error event', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/werr' });
		const deps = createMockDeps({
			spawnWorker: vi.fn(
				(
					_issue: string,
					_slug: string,
					_path: string,
					onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
				) => {
					process.nextTick(() => onEvent('error', new Error('spawn claude ENOENT')));
					return { id: 'test-1', issue: '10', groupSlug: 'test', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('spawn claude ENOENT');
	});

	it('handles invalid branch name gracefully', async () => {
		const group = makeGroup({ pr_number: 1, branch: '' });
		const deps = createMockDeps();

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('invalid branch name');
		expect(deps.createWorktree).not.toHaveBeenCalled();
	});

	it('handles group with zero issues', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/empty', issues: [] });
		const deps = createMockDeps();

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(true);
		expect(deps.spawnWorker).not.toHaveBeenCalled();
	});
});

// --- onMerge ---

describe('onMerge', () => {
	it('adds merged PR and re-evaluates', async () => {
		const groups = [
			makeGroup({ pr_number: 1, branch: 'feat/dep', status: 'merged', depends_on: [] }),
			makeGroup({ pr_number: 2, branch: 'feat/blocked', depends_on: [1] }),
		];
		const deps = createMockDeps();

		const result = await onMerge(1, makePlan(groups), new Set(), BASE_CONFIG, deps, now);

		// Group 1 is merged (excluded), Group 2 now has dep satisfied
		expect(result.assigned).toBe(1);
		expect(result.results[0]?.pr_number).toBe(2);
	});

	it('does not mutate input mergedPRs set', async () => {
		const groups = [makeGroup({ pr_number: 2, branch: 'feat/x', depends_on: [1] })];
		const originalMerged = new Set([0]);
		const deps = createMockDeps();

		await onMerge(1, makePlan(groups), originalMerged, BASE_CONFIG, deps, now);

		expect(originalMerged.has(1)).toBe(false);
	});

	it('returns assigned=0 if merge does not unlock anything', async () => {
		const groups = [makeGroup({ pr_number: 3, branch: 'feat/y', depends_on: [1, 2] })];
		const deps = createMockDeps();

		const result = await onMerge(1, makePlan(groups), new Set(), BASE_CONFIG, deps, now);

		expect(result.assigned).toBe(0);
	});
});
