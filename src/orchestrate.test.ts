import { describe, expect, it, vi } from 'vitest';
import { orchestrate } from './orchestrate.js';
import type {
	GroupStatus,
	NdjsonMessage,
	OrchestratorConfig,
	PlanData,
	SchedulerDeps,
	WorkerEventType,
} from './types.js';

const TEST_CONFIG: OrchestratorConfig = {
	base_branch: 'main',
	max_concurrent_agents: 3,
	max_retries_on_fail: 2,
	max_review_cycles: 3,
	verify: [{ name: 'lint', command: 'echo ok' }],
	rule_files: [],
	issue_source: { type: 'github', repo: 'test/repo' },
	notifications: { system: true },
};

function makePlan(groups: PlanData['groups']): PlanData {
	return { title: 'Test Plan', groups };
}

function makeGroup(overrides: Partial<PlanData['groups'][number]> = {}) {
	return {
		pr_number: 1,
		title: 'Type Cleanup',
		branch: 'feat/type-cleanup',
		status: 'pending' as const,
		issues: [{ number: 30, title: 'Fix types', status: 'open', blocked_by: [] }],
		depends_on: [],
		...overrides,
	};
}

/** In-memory status store so readGroupStatus returns latest write. */
function createStatusStore() {
	const store = new Map<string, GroupStatus>();
	return {
		read: (slug: string): GroupStatus | null => store.get(slug) ?? null,
		write: (slug: string, data: GroupStatus): void => {
			store.set(slug, data);
		},
	};
}

function buildMockDeps(
	statusStore: ReturnType<typeof createStatusStore>,
	options?: {
		workerExitCode?: number;
		verifySuccess?: boolean;
		worktreeError?: Error;
	},
): SchedulerDeps {
	const { workerExitCode = 0, verifySuccess = true, worktreeError } = options ?? {};

	return {
		createWorktree: vi.fn().mockImplementation((branch: string) => {
			if (worktreeError) throw worktreeError;
			return { branch, worktreePath: `/tmp/mock-worktree-${branch}` };
		}),
		removeWorktree: vi.fn(),
		spawnWorker: vi
			.fn()
			.mockImplementation(
				(
					_issue: string,
					_slug: string,
					_path: string,
					onEvent: (event: WorkerEventType, data: NdjsonMessage | number | Error) => void,
				) => {
					process.nextTick(() => onEvent('spawned', 0));
					process.nextTick(() => onEvent('exited', workerExitCode));
					return { id: `mock-${_issue}`, issue: _issue, groupSlug: _slug, pid: 999 };
				},
			),
		killWorker: vi.fn().mockResolvedValue(undefined),
		verify: vi.fn().mockResolvedValue({
			success: verifySuccess,
			failedStep: verifySuccess ? undefined : 'lint',
			error: verifySuccess ? undefined : 'lint failed',
			steps: [],
		}),
		readGroupStatus: vi.fn().mockImplementation((slug: string) => statusStore.read(slug)),
		writeGroupStatus: vi.fn().mockImplementation((slug: string, data: GroupStatus) => {
			statusStore.write(slug, data);
		}),
		readContext: vi.fn().mockReturnValue(null),
		deleteContext: vi.fn(),
	};
}

describe('orchestrate', () => {
	it('processes one group with one issue end-to-end', async () => {
		const plan = makePlan([makeGroup()]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.assigned).toBe(1);
		expect(result.results[0].completed).toBe(true);

		expect(progress).toContain('Starting PR 1: Type Cleanup [feat/type-cleanup]');
		expect(progress).toContain('  Issue #30: implementing...');
		expect(progress).toContain('  Issue #30: verifying...');
		expect(progress).toContain('  Issue #30: done');
		expect(progress).toContain('PR group ready for review: feat-type-cleanup');
	});

	it('processes multiple issues serially in one group', async () => {
		const plan = makePlan([
			makeGroup({
				issues: [
					{ number: 30, title: 'Fix types', status: 'open', blocked_by: [] },
					{ number: 31, title: 'Add tests', status: 'open', blocked_by: [30] },
				],
			}),
		]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.assigned).toBe(1);
		expect(result.results[0].completed).toBe(true);

		// Both issues processed
		expect(progress).toContain('  Issue #30: implementing...');
		expect(progress).toContain('  Issue #30: done');
		expect(progress).toContain('  Issue #31: implementing...');
		expect(progress).toContain('  Issue #31: done');

		// Order: 30 completes before 31 starts
		const idx30done = progress.indexOf('  Issue #30: done');
		const idx31impl = progress.indexOf('  Issue #31: implementing...');
		expect(idx30done).toBeLessThan(idx31impl);

		expect(progress).toContain('PR group ready for review: feat-type-cleanup');
	});

	it('completes with empty plan (no groups)', async () => {
		const plan = makePlan([]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.assigned).toBe(0);
		expect(result.results).toEqual([]);
		// No progress lines beyond header
		expect(progress).toEqual([]);
	});

	it('does not emit Starting header for blocked groups', async () => {
		const plan = makePlan([
			makeGroup({ pr_number: 1, title: 'First', branch: 'feat/first', depends_on: [] }),
			makeGroup({ pr_number: 2, title: 'Second', branch: 'feat/second', depends_on: [1] }),
		]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(progress).toContain('Starting PR 1: First [feat/first]');
		expect(progress).not.toContain('Starting PR 2: Second [feat/second]');
	});

	it('reports error on worker failure', async () => {
		const plan = makePlan([makeGroup()]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore, { workerExitCode: 1 });

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.results[0].completed).toBe(false);
		expect(result.results[0].error).toContain('worker exited with code 1');
		expect(progress).toContain('  Issue #30: implementing...');
		// No "done" or "ready for review"
		expect(progress).not.toContain('  Issue #30: done');
		expect(progress.find((p) => p.includes('ready for review'))).toBeUndefined();
	});

	it('reports error on verification failure', async () => {
		const plan = makePlan([makeGroup()]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore, { verifySuccess: false });

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.results[0].completed).toBe(false);
		expect(result.results[0].error).toContain('verification failed');
		expect(progress).toContain('  Issue #30: implementing...');
		expect(progress).toContain('  Issue #30: verifying...');
		expect(progress).not.toContain('  Issue #30: done');
	});

	it('reports error on worktree creation failure', async () => {
		const plan = makePlan([makeGroup()]);
		const progress: string[] = [];
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore, {
			worktreeError: new Error('disk full'),
		});

		const result = await orchestrate('plan.md', (msg) => progress.push(msg), {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(result.results[0].completed).toBe(false);
		expect(result.results[0].error).toContain('worktree error');
		expect(progress).not.toContain('  Issue #30: done');
	});

	it('status files update via writeGroupStatus', async () => {
		const plan = makePlan([makeGroup()]);
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		await orchestrate('plan.md', () => {}, {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		// writeGroupStatus called multiple times (cloning, coding, verifying, idle, reviewing)
		expect(deps.writeGroupStatus).toHaveBeenCalled();
		const calls = (deps.writeGroupStatus as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(5);

		// Final status is reviewing
		const finalStatus = statusStore.read('feat-type-cleanup');
		expect(finalStatus?.step).toBe('reviewing');
	});

	it('spawns worker with correct issue number', async () => {
		const plan = makePlan([makeGroup()]);
		const statusStore = createStatusStore();
		const deps = buildMockDeps(statusStore);

		await orchestrate('plan.md', () => {}, {
			loadConfig: () => TEST_CONFIG,
			parsePlan: async () => plan,
			deps,
		});

		expect(deps.spawnWorker).toHaveBeenCalledWith(
			'30',
			'feat-type-cleanup',
			expect.stringContaining('mock-worktree'),
			expect.any(Function),
			undefined,
		);
	});
});
