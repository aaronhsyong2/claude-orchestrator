import { startMergeDetector } from './merge-detector.js';
import { buildPRBody, pushAndCreatePR } from './pr-creator.js';
import { prReview } from './pr-reviewer.js';
import { executeWithRetry } from './retry-coordinator.js';
import { selfReview } from './self-reviewer.js';
import { deriveSlug } from './slug.js';
import type {
	AssignWorkResult,
	GroupStatus,
	MergeDetectorDeps,
	MergeDetectorResult,
	OrchestratorConfig,
	PlanData,
	PRGroup,
	SchedulerDeps,
	WorkerCapableDeps,
	WorktreeInfo,
} from './types.js';

/** Default maximum wait for merge: 24 hours. */
const DEFAULT_MERGE_WAIT_MS = 24 * 60 * 60 * 1000;

export function getReadyGroups(plan: PlanData, mergedPRs: ReadonlySet<number>): readonly PRGroup[] {
	return plan.groups.filter((group) => {
		if (group.status === 'done' || group.status === 'merged') return false;
		return group.depends_on.every((dep) => mergedPRs.has(dep));
	});
}

function initGroupStatus(group: PRGroup, slug: string, now: () => string): GroupStatus {
	return {
		pr_group: slug,
		branch: group.branch,
		current_issue: null,
		step: 'idle',
		step_result: '',
		issues_completed: [],
		issues_remaining: group.issues.map((i) => i.number),
		last_updated: now(),
	};
}

/** Extract the common WorkerCapableDeps subset from SchedulerDeps. */
function coreWorkerDeps(deps: SchedulerDeps, now?: () => string): WorkerCapableDeps {
	return {
		spawnWorker: deps.spawnWorker,
		verify: deps.verify,
		readContext: deps.readContext,
		writeContext: deps.writeContext,
		writeGroupStatus: deps.writeGroupStatus,
		notify: deps.notify,
		now,
	};
}

/** Extract MergeDetectorDeps subset from SchedulerDeps. */
function coreMergeDetectorDeps(deps: SchedulerDeps): MergeDetectorDeps {
	return { execCommand: deps.execCommand };
}

/**
 * Block until the merge detector completes (merged, closed, or timeout).
 * Returns the completion result.
 */
function waitForMerge(
	prNumber: number,
	branch: string,
	baseBranch: string,
	cwd: string,
	deps: SchedulerDeps,
	maxWaitMs: number = DEFAULT_MERGE_WAIT_MS,
): Promise<MergeDetectorResult> {
	return new Promise<MergeDetectorResult>((resolve) => {
		let resolved = false;
		let handle: ReturnType<typeof startMergeDetector> | null = null;
		handle = startMergeDetector(
			prNumber,
			branch,
			baseBranch,
			cwd,
			(result) => {
				if (!resolved) {
					resolved = true;
					handle?.stop();
					resolve(result);
				}
			},
			coreMergeDetectorDeps(deps),
			{ maxWaitMs },
		);
	});
}

function notifySafe(
	deps: SchedulerDeps,
	slug: string,
	message: string,
	config: OrchestratorConfig,
): void {
	deps.notify(`${slug}: ${message}`, config.notifications).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[scheduler] notification failed: ${msg}\n`);
	});
}

/** Wrap writeGroupStatus to prevent I/O errors from crashing the entire orchestration. */
function safeWriteStatus(deps: SchedulerDeps, slug: string, data: GroupStatus): void {
	try {
		deps.writeGroupStatus(slug, data);
	} catch (err) {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		process.stderr.write(`[scheduler] status write failed for ${slug}: ${detail}\n`);
	}
}

/** Re-read current status from disk before every write to avoid stale spreads. */
function freshStatus(
	slug: string,
	group: PRGroup,
	deps: SchedulerDeps,
	now: () => string,
): GroupStatus {
	return deps.readGroupStatus(slug) ?? initGroupStatus(group, slug, now);
}

async function processIssue(
	group: PRGroup,
	issueNumber: number,
	slug: string,
	config: OrchestratorConfig,
	deps: SchedulerDeps,
	now: () => string,
): Promise<{ readonly success: boolean; readonly error?: string }> {
	// cloning
	safeWriteStatus(deps, slug, {
		...freshStatus(slug, group, deps, now),
		current_issue: issueNumber,
		step: 'cloning',
		step_result: '',
		last_updated: now(),
	});

	// Create worktree
	let worktreeInfo: WorktreeInfo;
	try {
		worktreeInfo = deps.createWorktree(group.branch, config.base_branch);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			current_issue: issueNumber,
			step: 'cloning',
			step_result: `worktree error: ${message}`,
			last_updated: now(),
		});
		return { success: false, error: `worktree error: ${message}` };
	}

	try {
		// coding
		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			current_issue: issueNumber,
			step: 'coding',
			step_result: '',
			last_updated: now(),
		});

		const currentStatus = freshStatus(slug, group, deps, now);
		const retryResult = await executeWithRetry(
			issueNumber,
			slug,
			worktreeInfo.worktreePath,
			currentStatus,
			config,
			coreWorkerDeps(deps, now),
		);

		if (!retryResult.success) {
			return {
				success: false,
				error: retryResult.escalationReason ?? 'retry failed',
			};
		}

		// Success — record completion, delete context
		const updatedStatus = freshStatus(slug, group, deps, now);
		safeWriteStatus(deps, slug, {
			...updatedStatus,
			current_issue: null,
			step: 'idle',
			step_result: 'pass',
			issues_completed: [...updatedStatus.issues_completed, issueNumber],
			issues_remaining: updatedStatus.issues_remaining.filter((n) => n !== issueNumber),
			last_updated: now(),
		});
		try {
			deps.deleteContext(slug, String(issueNumber));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`[scheduler] context delete failed for ${slug}/${issueNumber}: ${message}\n`,
			);
		}

		return { success: true };
	} finally {
		try {
			deps.removeWorktree(group.branch);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[scheduler] worktree cleanup failed for ${group.branch}: ${message}\n`);
		}
	}
}

async function processGroup(
	group: PRGroup,
	config: OrchestratorConfig,
	deps: SchedulerDeps,
	now: () => string,
): Promise<{
	readonly completed: boolean;
	readonly failedIssue?: number;
	readonly error?: string;
}> {
	let slug: string;
	try {
		slug = deriveSlug(group.branch);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { completed: false, error: `invalid branch name: ${message}` };
	}

	const existing = deps.readGroupStatus(slug);
	if (!existing) {
		safeWriteStatus(deps, slug, initGroupStatus(group, slug, now));
	}

	// Read issues_remaining from persisted status so resumed runs skip completed issues.
	// Within a single run, processIssue updates issues_remaining on disk after each success.
	// The loop iterates over the snapshot captured here — this is safe because no external
	// actor modifies the status of a running group within the same orchestrator process.
	const status = deps.readGroupStatus(slug) ?? initGroupStatus(group, slug, now);
	const remaining = status.issues_remaining;

	for (const issueNumber of remaining) {
		const result = await processIssue(group, issueNumber, slug, config, deps, now);
		if (!result.success) {
			return { completed: false, failedIssue: issueNumber, error: result.error };
		}
	}

	// All issues complete — run self-review cycle
	safeWriteStatus(deps, slug, {
		...freshStatus(slug, group, deps, now),
		step: 'reviewing',
		step_result: 'self-review starting',
		last_updated: now(),
	});

	// Create worktree for review phase (branch already has all committed work)
	let reviewWorktree: WorktreeInfo;
	try {
		reviewWorktree = deps.createWorktree(group.branch, config.base_branch);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			step: 'reviewing',
			step_result: `worktree error: ${message}`,
			last_updated: now(),
		});
		return { completed: false, error: `review worktree error: ${message}` };
	}

	try {
		const reviewResult = await selfReview(
			slug,
			reviewWorktree.worktreePath,
			freshStatus(slug, group, deps, now),
			config,
			coreWorkerDeps(deps, now),
		);

		if (!reviewResult.approved) {
			safeWriteStatus(deps, slug, {
				...freshStatus(slug, group, deps, now),
				step: 'idle',
				step_result: 'needs-input',
				last_updated: now(),
			});
			notifySafe(
				deps,
				slug,
				`self-review found unresolved critical/high findings after ${reviewResult.cycle} cycle(s)`,
				config,
			);
			return {
				completed: false,
				error: 'self-review: unresolved critical/high findings',
			};
		}

		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			step: 'pr-creating',
			step_result: 'pushing branch',
			last_updated: now(),
		});

		// --- PR Creation ---
		let prNumber: number;
		try {
			const issuesCompleted = freshStatus(slug, group, deps, now).issues_completed;
			const prResult = await pushAndCreatePR(
				group.branch,
				config.base_branch,
				group.title,
				buildPRBody(group.title, issuesCompleted),
				reviewWorktree.worktreePath,
				{ execCommand: deps.execCommand },
			);
			prNumber = prResult.prNumber;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			safeWriteStatus(deps, slug, {
				...freshStatus(slug, group, deps, now),
				step: 'pr-creating',
				step_result: `failed: ${message}`,
				last_updated: now(),
			});
			return { completed: false, error: `pr creation failed: ${message}` };
		}

		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			step: 'pr-reviewing',
			step_result: `PR #${prNumber} created`,
			last_updated: now(),
		});

		// --- PR Review Loop ---
		const prReviewResult = await prReview(
			prNumber,
			slug,
			reviewWorktree.worktreePath,
			freshStatus(slug, group, deps, now),
			config,
			{ ...coreWorkerDeps(deps, now), execCommand: deps.execCommand },
		);

		if (!prReviewResult.approved) {
			safeWriteStatus(deps, slug, {
				...freshStatus(slug, group, deps, now),
				step: 'idle',
				step_result: 'needs-input',
				last_updated: now(),
			});
			notifySafe(
				deps,
				slug,
				`PR #${prNumber} has unresolved comments after ${prReviewResult.cycle} cycle(s)`,
				config,
			);
			return { completed: false, error: 'pr-review: unresolved comments' };
		}

		notifySafe(deps, slug, `PR #${prNumber} ready to merge`, config);

		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			step: 'awaiting-merge',
			step_result: `PR #${prNumber} approved`,
			last_updated: now(),
		});

		// --- Merge Detection ---
		const mergeResult = await waitForMerge(
			prNumber,
			group.branch,
			config.base_branch,
			reviewWorktree.worktreePath,
			deps,
		);

		if (mergeResult === 'merged') {
			return { completed: true };
		}

		// CLOSED or timeout — escalate
		const reason =
			mergeResult === 'closed'
				? `PR #${prNumber} was closed without merging`
				: `PR #${prNumber} merge wait timed out`;

		safeWriteStatus(deps, slug, {
			...freshStatus(slug, group, deps, now),
			step: 'idle',
			step_result: 'needs-input',
			last_updated: now(),
		});
		notifySafe(deps, slug, reason, config);
		return { completed: false, error: reason };
	} finally {
		try {
			deps.removeWorktree(group.branch);
		} catch (cleanupErr) {
			const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
			process.stderr.write(
				`[scheduler] review worktree cleanup failed for ${group.branch}: ${message}\n`,
			);
		}
	}
}

export async function assignWork(
	plan: PlanData,
	mergedPRs: ReadonlySet<number>,
	config: OrchestratorConfig,
	deps: SchedulerDeps,
	now: () => string = () => new Date().toISOString(),
): Promise<AssignWorkResult> {
	const ready = getReadyGroups(plan, mergedPRs);

	if (ready.length === 0) {
		return { assigned: 0, results: [] };
	}

	const toAssign = ready.slice(0, config.max_concurrent_agents);

	// Guard against slug collisions — two branches mapping to the same slug
	// would corrupt each other's status files when processed concurrently.
	const slugSet = new Set<string>();
	for (const group of toAssign) {
		const slug = deriveSlug(group.branch);
		if (slugSet.has(slug)) {
			throw new Error(
				`Slug collision: multiple groups resolve to "${slug}" — disambiguate branch names`,
			);
		}
		slugSet.add(slug);
	}

	const settled = await Promise.allSettled(
		toAssign.map((group) => processGroup(group, config, deps, now)),
	);

	return {
		assigned: toAssign.length,
		results: toAssign.map((group, i) => {
			const outcome = settled[i];
			const result =
				outcome.status === 'fulfilled'
					? outcome.value
					: {
							completed: false,
							error:
								outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
						};
			return {
				pr_number: group.pr_number,
				branch: group.branch,
				...result,
			};
		}),
	};
}

export async function onMerge(
	prNumber: number,
	plan: PlanData,
	currentMergedPRs: ReadonlySet<number>,
	config: OrchestratorConfig,
	deps: SchedulerDeps,
	now: () => string = () => new Date().toISOString(),
): Promise<AssignWorkResult> {
	const updatedMerged = new Set(currentMergedPRs);
	updatedMerged.add(prNumber);
	return assignWork(plan, updatedMerged, config, deps, now);
}
