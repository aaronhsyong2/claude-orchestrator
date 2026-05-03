import { loadConfig as realLoadConfig } from './config.js';
import { parsePlan as realParsePlan } from './parser.js';
import { assignWork, getReadyGroups } from './scheduler.js';
import {
	deleteContext as realDeleteContext,
	readContext as realReadContext,
	readGroupStatus as realReadGroupStatus,
	writeGroupStatus as realWriteGroupStatus,
} from './status-manager.js';
import type {
	AssignWorkResult,
	GroupStatus,
	OrchestratorConfig,
	PlanData,
	SchedulerDeps,
} from './types.js';
import { verify as realVerify } from './verification.js';
import { killWorker as realKillWorker, spawnWorker as realSpawnWorker } from './worker-manager.js';
import { create as realCreate, remove as realRemove } from './worktree-manager.js';

export type ProgressCallback = (message: string) => void;

export interface OrchestrateOverrides {
	readonly loadConfig?: () => OrchestratorConfig;
	readonly parsePlan?: (filePath: string) => Promise<PlanData>;
	readonly deps?: SchedulerDeps;
}

export async function orchestrate(
	planPath: string,
	onProgress: ProgressCallback,
	overrides?: OrchestrateOverrides,
): Promise<AssignWorkResult> {
	const config = (overrides?.loadConfig ?? realLoadConfig)();
	const plan = await (overrides?.parsePlan ?? realParsePlan)(planPath);

	const rawDeps = overrides?.deps ?? buildRealDeps();
	const deps = wrapWithProgress(rawDeps, onProgress);
	const mergedPRs = new Set<number>();

	const ready = getReadyGroups(plan, mergedPRs);
	for (const group of ready) {
		onProgress(`Starting PR ${group.pr_number}: ${group.title} [${group.branch}]`);
	}

	return assignWork(plan, mergedPRs, config, deps);
}

function buildRealDeps(): SchedulerDeps {
	return {
		createWorktree: (branch, baseBranch) => realCreate(branch, baseBranch),
		removeWorktree: (branch) => realRemove(branch),
		spawnWorker: (issue, groupSlug, worktreePath, onEvent, context) =>
			realSpawnWorker(issue, groupSlug, worktreePath, onEvent, context),
		killWorker: realKillWorker,
		verify: (cwd, commands) => realVerify(cwd, commands),
		readGroupStatus: realReadGroupStatus,
		writeGroupStatus: realWriteGroupStatus,
		readContext: realReadContext,
		deleteContext: realDeleteContext,
	};
}

function wrapWithProgress(deps: SchedulerDeps, onProgress: ProgressCallback): SchedulerDeps {
	return {
		...deps,
		writeGroupStatus: (slug, data) => {
			deps.writeGroupStatus(slug, data);
			emitProgress(onProgress, data);
		},
	};
}

function emitProgress(onProgress: ProgressCallback, data: GroupStatus): void {
	if (data.current_issue !== null) {
		if (data.step === 'coding') {
			onProgress(`  Issue #${data.current_issue}: implementing...`);
		} else if (data.step === 'verifying') {
			onProgress(`  Issue #${data.current_issue}: verifying...`);
		}
	}

	if (data.step === 'idle' && data.step_result === 'pass') {
		const last = data.issues_completed[data.issues_completed.length - 1];
		if (last !== undefined) {
			onProgress(`  Issue #${last}: done`);
		}
	}

	if (data.step === 'reviewing') {
		onProgress(`PR group ready for review: ${data.pr_group}`);
	}
}
