import { executeWithRetry } from './retry-coordinator.js';
import { deriveSlug } from './slug.js';
import type {
	AssignWorkResult,
	GroupStatus,
	OrchestratorConfig,
	PlanData,
	PRGroup,
	SchedulerDeps,
	WorktreeInfo,
} from './types.js';

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
			{
				spawnWorker: deps.spawnWorker,
				verify: deps.verify,
				readContext: deps.readContext,
				writeContext: deps.writeContext,
				writeGroupStatus: deps.writeGroupStatus,
				notify: deps.notify,
			},
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

	// All issues complete — signal ready for review
	const finalStatus = freshStatus(slug, group, deps, now);
	safeWriteStatus(deps, slug, {
		...finalStatus,
		step: 'reviewing',
		step_result: 'ready for self-review',
		last_updated: now(),
	});

	return { completed: true };
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
