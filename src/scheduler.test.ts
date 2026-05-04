import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignWork, getReadyGroups, onMerge } from './scheduler.js';
import type {
	GroupStatus,
	OrchestratorConfig,
	PlanData,
	PRGroup,
	SchedulerDeps,
	WorkerEvent,
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
			(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
				process.nextTick(() => {
					// Emit a result message so self-reviewer can capture output
					onEvent({
						event: 'message',
						data: { type: 'result', result: '[]', is_error: false },
					});
					onEvent({ event: 'exited', data: 0 });
				});
				return { id: 'test-1', issue: '1', groupSlug: 'test', pid: 123 } satisfies WorkerHandle;
			},
		),
		spawnDirectWorker: vi.fn(
			(_id: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
				process.nextTick(() => {
					onEvent({
						event: 'message',
						data: { type: 'result', result: '[]', is_error: false },
					});
					onEvent({ event: 'exited', data: 0 });
				});
				return {
					id: 'test-direct',
					issue: 'direct',
					groupSlug: 'test',
					pid: 124,
				} satisfies WorkerHandle;
			},
		),
		killWorker: vi.fn(async () => {}),
		verify: vi.fn(async () => ({ success: true as const, steps: [] })),
		readGroupStatus: vi.fn((slug: string) => statuses.get(slug) ?? null),
		writeGroupStatus: vi.fn((slug: string, data: GroupStatus) => {
			statuses.set(slug, data);
		}),
		readContext: vi.fn(() => null),
		writeContext: vi.fn(),
		deleteContext: vi.fn(),
		execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
			// gh pr view <branch> --json number,url → no existing PR
			if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('number,url')) {
				return { exitCode: 1, stdout: '', stderr: 'no PR found' };
			}
			// gh pr create → success
			if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
				return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/1\n', stderr: '' };
			}
			// gh pr view <number> --json state → merged (for merge detector)
			if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
				return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
			}
			// git push
			if (cmd === 'git' && args[0] === 'push') {
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			// git commit
			if (cmd === 'git' && args[0] === 'commit') {
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		}),
		notify: vi.fn(async () => {}),
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
				(issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					spawnOrder.push(issue);
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: `test-${issue}`, issue, groupSlug: 'feat-multi', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(true);
		// Issues 10, 11, 12 processed in order, then review-feat-multi for self-review
		expect(spawnOrder.slice(0, 3)).toEqual(['10', '11', '12']);
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
				(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					process.nextTick(() => onEvent({ event: 'exited', data: 1 }));
					return { id: 'test-1', issue: '10', groupSlug: 'feat-fail', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.failedIssue).toBe(10);
		expect(result.results[0]?.error).toContain('crashed 2 times consecutively');
		// Crash escalation: retry once silently, escalate on second crash
		expect(deps.spawnWorker).toHaveBeenCalledTimes(2);
	});

	it('stops on verification failure after retries', async () => {
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
		expect(result.results[0]?.error).toContain('max retries exhausted');
	});

	it('sets step to reviewing when all issues complete', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/review' });
		const deps = createMockDeps();

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const lastCall = writeStatusMock.mock.calls[writeStatusMock.mock.calls.length - 1];
		expect(lastCall?.[1].step).toBe('awaiting-merge');
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
		// init(idle) → cloning → coding → verifying → idle(pass)
		// → reviewing(self-review starting) → reviewing(review cycle 1) → reviewing(self-review passed)
		// → pr-creating → pr-reviewing → pr-reviewing(PR review cycle 1) → awaiting-merge
		expect(steps).toEqual([
			'idle',
			'cloning',
			'coding',
			'verifying',
			'idle',
			'reviewing',
			'reviewing',
			'pr-creating',
			'pr-reviewing',
			'pr-reviewing',
			'awaiting-merge',
		]);
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
				(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					process.nextTick(() => onEvent({ event: 'exited', data: 1 }));
					return { id: 'test-1', issue: '10', groupSlug: 'test', pid: 123 };
				},
			),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.deleteContext).not.toHaveBeenCalled();
	});

	it('calls removeWorktree after successful issue processing', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/cleanup' });
		const deps = createMockDeps();

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/cleanup');
	});

	it('calls removeWorktree even after worker failure', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/cleanup-fail' });
		const deps = createMockDeps({
			spawnWorker: vi.fn(
				(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					process.nextTick(() => onEvent({ event: 'exited', data: 1 }));
					return { id: 'test-1', issue: '10', groupSlug: 'test', pid: 123 };
				},
			),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/cleanup-fail');
	});

	it('calls removeWorktree even after verification failure', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/cleanup-vfail' });
		const deps = createMockDeps({
			verify: vi.fn(async () => ({
				success: false as const,
				failedStep: 'lint',
				error: 'lint errors',
				steps: [],
			})),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/cleanup-vfail');
	});

	it('does not call removeWorktree when createWorktree fails', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/no-cleanup' });
		const deps = createMockDeps({
			createWorktree: vi.fn(() => {
				throw new Error('Disk full');
			}),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(deps.removeWorktree).not.toHaveBeenCalled();
	});

	it('resumes from persisted status skipping completed issues', async () => {
		const spawnOrder: string[] = [];
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/resume',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
				{ number: 12, title: 'Third', status: 'Open', blocked_by: [] },
			],
		});

		const statuses = new Map<string, GroupStatus>();
		// Pre-seed: issue 10 already completed
		statuses.set('feat-resume', {
			pr_group: 'feat-resume',
			branch: 'feat/resume',
			current_issue: null,
			step: 'idle',
			step_result: 'pass',
			issues_completed: [10],
			issues_remaining: [11, 12],
			last_updated: NOW,
		});

		const deps = createMockDeps({
			readGroupStatus: vi.fn((slug: string) => statuses.get(slug) ?? null),
			writeGroupStatus: vi.fn((slug: string, data: GroupStatus) => {
				statuses.set(slug, data);
			}),
			spawnWorker: vi.fn(
				(issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					spawnOrder.push(issue);
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: `test-${issue}`, issue, groupSlug: 'feat-resume', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(true);
		// Only issues 11 and 12 should be processed — issue 10 was already done
		// Then review-feat-resume for self-review
		expect(spawnOrder.slice(0, 2)).toEqual(['11', '12']);
	});

	it('detects slug collision and throws', async () => {
		const groups = [
			makeGroup({ pr_number: 1, branch: 'feat/my-branch' }),
			makeGroup({ pr_number: 2, branch: 'feat-my-branch' }),
		];
		const deps = createMockDeps();

		await expect(assignWork(makePlan(groups), new Set(), BASE_CONFIG, deps, now)).rejects.toThrow(
			/Slug collision/,
		);
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
				(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					process.nextTick(() =>
						onEvent({ event: 'error', data: new Error('spawn claude ENOENT') }),
					);
					return { id: 'test-1', issue: '10', groupSlug: 'test', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('crashed 2 times consecutively');
	});

	it('runs pnpm install after worktree creation before coding', async () => {
		const callOrder: string[] = [];
		const group = makeGroup({ pr_number: 1, branch: 'feat/install' });
		const deps = createMockDeps({
			createWorktree: vi.fn(() => {
				callOrder.push('createWorktree');
				return { branch: 'feat/install', worktreePath: '/tmp/wt-install' };
			}),
			execCommand: vi.fn(async (cmd: string, args: readonly string[], _cwd: string) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					callOrder.push('pnpm-install');
					return { exitCode: 0, stdout: 'installed', stderr: '' };
				}
				// gh pr view <branch> --json number,url → no existing PR
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('number,url')) {
					return { exitCode: 1, stdout: '', stderr: 'no PR found' };
				}
				// gh pr create → success
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
					return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/1\n', stderr: '' };
				}
				// gh pr view <number> --json state → merged
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
					return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
				}
				if (cmd === 'git') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
			spawnWorker: vi.fn(
				(_issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					callOrder.push('spawnWorker');
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: 'test-1', issue: '10', groupSlug: 'feat-install', pid: 123 };
				},
			),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		// pnpm install must happen after worktree creation, before worker spawn
		const wtIdx = callOrder.indexOf('createWorktree');
		const installIdx = callOrder.indexOf('pnpm-install');
		const spawnIdx = callOrder.indexOf('spawnWorker');
		expect(installIdx).toBeGreaterThan(wtIdx);
		expect(installIdx).toBeLessThan(spawnIdx);

		// Verify called with correct cwd
		expect(deps.execCommand).toHaveBeenCalledWith('pnpm', ['install'], '/tmp/wt-install');
	});

	it('treats pnpm install failure as non-retryable worktree error', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/install-fail' });
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					return { exitCode: 1, stdout: '', stderr: 'ERR_PNPM_LOCKFILE' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('install error');
		// Non-retryable — worker should not be spawned
		expect(deps.spawnWorker).not.toHaveBeenCalled();
		// Worktree cleaned up despite install failure
		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/install-fail');
	});

	it('status stays cloning during pnpm install', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/install-status' });
		let statusDuringInstall: string | undefined;
		const statuses = new Map<string, GroupStatus>();
		const deps = createMockDeps({
			readGroupStatus: vi.fn((slug: string) => statuses.get(slug) ?? null),
			writeGroupStatus: vi.fn((slug: string, data: GroupStatus) => {
				statuses.set(slug, data);
			}),
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install' && statusDuringInstall === undefined) {
					// Capture status during first install (issue worktree, not review)
					statusDuringInstall = statuses.get('feat-install-status')?.step;
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'pnpm' && args[0] === 'install') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('number,url')) {
					return { exitCode: 1, stdout: '', stderr: 'no PR found' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
					return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/1\n', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
					return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(statusDuringInstall).toBe('cloning');
	});

	it('runs pnpm install in review worktree before self-review', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/review-install' });
		const installCwds: string[] = [];
		let worktreeCallCount = 0;
		const deps = createMockDeps({
			createWorktree: vi.fn(() => {
				worktreeCallCount++;
				// First call: issue worktree, second call: review worktree
				const wtPath = worktreeCallCount === 1 ? '/tmp/wt-issue' : '/tmp/wt-review';
				return { branch: 'feat/review-install', worktreePath: wtPath };
			}),
			execCommand: vi.fn(async (cmd: string, args: readonly string[], cwd: string) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					installCwds.push(cwd);
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('number,url')) {
					return { exitCode: 1, stdout: '', stderr: 'no PR found' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
					return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/1\n', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
					return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		// pnpm install called for both issue worktree and review worktree
		expect(installCwds).toContain('/tmp/wt-issue');
		expect(installCwds).toContain('/tmp/wt-review');
	});

	it('install failure captures stdout/stderr in status', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/install-log' });
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					return { exitCode: 1, stdout: 'resolving...', stderr: 'ERR_PNPM_LOCKFILE' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const installErrorCalls = writeStatusMock.mock.calls.filter((call) =>
			call[1].step_result.includes('install error'),
		);
		expect(installErrorCalls.length).toBeGreaterThanOrEqual(1);
		expect(installErrorCalls[0]?.[1].step_result).toContain('ERR_PNPM_LOCKFILE');
	});

	it('handles pnpm install timeout', async () => {
		vi.useFakeTimers();
		const group = makeGroup({ pr_number: 1, branch: 'feat/install-timeout' });
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					// Never resolve — simulate hanging install
					return new Promise<{ exitCode: number; stdout: string; stderr: string }>(() => {});
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const resultPromise = assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);
		// Advance past the 120s default timeout
		await vi.advanceTimersByTimeAsync(121_000);
		const result = await resultPromise;

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('pnpm install timed out');
		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/install-timeout');
		vi.useRealTimers();
	});

	it('handles review worktree install failure', async () => {
		let installCallCount = 0;
		const group = makeGroup({ pr_number: 1, branch: 'feat/review-install-fail' });
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					installCallCount++;
					// First call (issue worktree) succeeds, second (review) fails
					if (installCallCount >= 2) {
						return { exitCode: 1, stdout: '', stderr: 'REVIEW_INSTALL_FAIL' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('number,url')) {
					return { exitCode: 1, stdout: '', stderr: 'no PR found' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
					return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/1\n', stderr: '' };
				}
				if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
					return { exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('REVIEW_INSTALL_FAIL');
		// Review worktree cleaned up
		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/review-install-fail');

		// Status should show reviewing step with install error
		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const reviewInstallError = writeStatusMock.mock.calls.find(
			(call) => call[1].step === 'reviewing' && call[1].step_result.includes('install error'),
		);
		expect(reviewInstallError).toBeDefined();
	});

	it('handles execCommand throw in installDependencies', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/install-throw' });
		const deps = createMockDeps({
			execCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
				if (cmd === 'pnpm' && args[0] === 'install') {
					throw new Error('ENOENT: pnpm not found');
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.error).toContain('pnpm not found');
		expect(deps.spawnWorker).not.toHaveBeenCalled();
		expect(deps.removeWorktree).toHaveBeenCalledWith('feat/install-throw');
	});

	it('handles invalid branch name gracefully', async () => {
		const group = makeGroup({ pr_number: 1, branch: '' });
		const deps = createMockDeps();

		await expect(assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now)).rejects.toThrow(
			/must not be empty/,
		);
		expect(deps.createWorktree).not.toHaveBeenCalled();
	});

	it('handles group with zero issues', async () => {
		const group = makeGroup({ pr_number: 1, branch: 'feat/empty', issues: [] });
		const deps = createMockDeps();

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		expect(result.results[0]?.completed).toBe(true);
		// spawnDirectWorker is called for self-review + PR review (no issue spawns)
		expect(deps.spawnDirectWorker).toHaveBeenCalledTimes(2);
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

// --- processGroup shutdown checkpoint ---

describe('processGroup shutdown', () => {
	it('when shouldShutdown returns graceful signal, loop stops before next issue', async () => {
		let callCount = 0;
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/shutdown',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
			],
		});

		const spawnOrder: string[] = [];
		const deps = createMockDeps({
			shouldShutdown: () => {
				callCount++;
				// Return null on first call (before issue 10), signal on second (before issue 11)
				if (callCount >= 2) {
					return { mode: 'graceful' as const, requested_at: NOW };
				}
				return null;
			},
			spawnWorker: vi.fn(
				(issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					spawnOrder.push(issue);
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: `test-${issue}`, issue, groupSlug: 'feat-shutdown', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		// Only the first issue should be processed
		expect(spawnOrder).toEqual(['10']);
		expect(result.results[0]?.completed).toBe(false);
		expect(result.results[0]?.shutdown).toBe(true);
	});

	it('status written with step_result interrupted on shutdown', async () => {
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/int',
			issues: [{ number: 10, title: 'Issue', status: 'Open', blocked_by: [] }],
		});

		const deps = createMockDeps({
			shouldShutdown: () => ({ mode: 'graceful' as const, requested_at: NOW }),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		const writeStatusMock = vi.mocked(deps.writeGroupStatus);
		const interruptedCalls = writeStatusMock.mock.calls.filter(
			(call) => call[1].step_result === 'interrupted',
		);
		expect(interruptedCalls.length).toBeGreaterThanOrEqual(1);
	});

	it('current issue completes before shutdown check (no mid-step interruption)', async () => {
		let shouldShutdownCallCount = 0;
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/complete-first',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
			],
		});

		const spawnOrder: string[] = [];
		const deps = createMockDeps({
			shouldShutdown: () => {
				shouldShutdownCallCount++;
				// Signal shutdown before second issue
				if (shouldShutdownCallCount >= 2) {
					return { mode: 'graceful' as const, requested_at: NOW };
				}
				return null;
			},
			spawnWorker: vi.fn(
				(issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					spawnOrder.push(issue);
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: `test-${issue}`, issue, groupSlug: 'feat-complete-first', pid: 123 };
				},
			),
		});

		await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		// First issue completed fully, second was not started
		expect(spawnOrder).toEqual(['10']);
	});

	it('when shouldShutdown is undefined (backward compat), loop runs normally', async () => {
		const group = makeGroup({
			pr_number: 1,
			branch: 'feat/no-shutdown',
			issues: [
				{ number: 10, title: 'First', status: 'Open', blocked_by: [] },
				{ number: 11, title: 'Second', status: 'Open', blocked_by: [] },
			],
		});

		const spawnOrder: string[] = [];
		const deps = createMockDeps({
			// shouldShutdown is NOT provided (undefined)
			spawnWorker: vi.fn(
				(issue: string, _slug: string, _path: string, onEvent: (event: WorkerEvent) => void) => {
					spawnOrder.push(issue);
					process.nextTick(() => {
						onEvent({
							event: 'message',
							data: { type: 'result', result: '[]', is_error: false },
						});
						onEvent({ event: 'exited', data: 0 });
					});
					return { id: `test-${issue}`, issue, groupSlug: 'feat-no-shutdown', pid: 123 };
				},
			),
		});

		const result = await assignWork(makePlan([group]), new Set(), BASE_CONFIG, deps, now);

		// Both issues processed
		expect(spawnOrder.slice(0, 2)).toEqual(['10', '11']);
		expect(result.results[0]?.completed).toBe(true);
	});
});
