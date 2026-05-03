import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig as realLoadConfig } from './config.js';
import { parsePlan as realParsePlan } from './parser.js';
import { assignWork, getReadyGroups } from './scheduler.js';
import {
	deleteContext as realDeleteContext,
	readContext as realReadContext,
	readGroupStatus as realReadGroupStatus,
	writeContext as realWriteContext,
	writeGroupStatus as realWriteGroupStatus,
} from './status-manager.js';
import { notify as realNotify } from './tui/notification-service.js';
import type {
	AssignWorkResult,
	ExecResult,
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
	const capped = ready.slice(0, config.max_concurrent_agents);
	for (const group of capped) {
		onProgress(`Starting PR ${group.pr_number}: ${group.title} [${group.branch}]`);
	}

	return assignWork(plan, mergedPRs, config, deps);
}

const execFileAsync = promisify(execFile);

async function realExecCommand(
	cmd: string,
	args: readonly string[],
	cwd: string,
): Promise<ExecResult> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, [...args], { cwd });
		return { exitCode: 0, stdout, stderr };
	} catch (err: unknown) {
		const e = err as { status?: number; code?: string | number; stdout?: string; stderr?: string };
		const exitCode = e.status ?? (typeof e.code === 'number' ? e.code : 1);
		return { exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
	}
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
		writeContext: realWriteContext,
		deleteContext: realDeleteContext,
		execCommand: realExecCommand,
		notify: realNotify,
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
		if (data.step === 'cloning') {
			onProgress(`  Issue #${data.current_issue}: cloning...`);
		} else if (data.step === 'coding') {
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
		onProgress(`  PR group ${data.pr_group}: reviewing...`);
	}

	if (data.step === 'pr-creating') {
		onProgress(`  PR group ${data.pr_group}: creating PR...`);
	}

	if (data.step === 'pr-reviewing') {
		onProgress(`  PR group ${data.pr_group}: PR review — ${data.step_result}`);
	}

	if (data.step === 'awaiting-merge') {
		onProgress(`  PR group ${data.pr_group}: awaiting merge`);
	}
}
