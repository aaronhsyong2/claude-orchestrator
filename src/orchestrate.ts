import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig as realLoadConfig } from './config.js';
import { parsePlan as realParsePlan } from './parser.js';
import { hasExistingState, resumeFromState } from './resume.js';
import { assignWork, getReadyGroups } from './scheduler.js';
import type { WorkerRegistry } from './shutdown.js';
import { createWorkerRegistry, forceKillAll, readShutdownFile } from './shutdown.js';
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
	GitBranchState,
	GroupStatus,
	OrchestratorConfig,
	PlanData,
	SchedulerDeps,
	ShutdownMode,
	WorkerEvent,
} from './types.js';
import { verify as realVerify } from './verification.js';
import {
	killWorker as realKillWorker,
	spawnDirectWorker as realSpawnDirectWorker,
	spawnWorker as realSpawnWorker,
} from './worker-manager.js';
import { create as realCreate, remove as realRemove } from './worktree-manager.js';

export type ProgressCallback = (message: string) => void;

export interface OrchestrateOverrides {
	readonly loadConfig?: () => OrchestratorConfig;
	readonly parsePlan?: (filePath: string) => Promise<PlanData>;
	readonly deps?: SchedulerDeps;
	readonly onShutdown?: (mode: ShutdownMode) => void;
	readonly hasExistingState?: () => boolean;
}

async function buildGitState(
	execCommand: (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>,
): Promise<GitBranchState> {
	const branchResult = await execCommand(
		'git',
		['branch', '--list', '--format=%(refname:short)'],
		'.',
	);
	if (branchResult.exitCode !== 0) {
		throw new Error(`git branch failed (exit ${branchResult.exitCode}): ${branchResult.stderr}`);
	}
	const branches = branchResult.stdout
		.split('\n')
		.map((b) => b.trim())
		.filter((b) => b.length > 0);

	const branchHasCommits = new Map<string, boolean>();
	for (const branch of branches) {
		const logResult = await execCommand('git', ['log', '--oneline', '-1', branch], '.');
		branchHasCommits.set(branch, logResult.exitCode === 0 && logResult.stdout.trim().length > 0);
	}

	return { branches, branchHasCommits };
}

function wrapSpawnWorker(
	original: SchedulerDeps['spawnWorker'],
	registry: WorkerRegistry,
): SchedulerDeps['spawnWorker'] {
	return (issue, groupSlug, worktreePath, onEvent, contextContent?) => {
		let pid = -1;
		const wrappedOnEvent = (event: WorkerEvent): void => {
			if (event.event === 'exited') {
				registry.deregister(pid);
			}
			onEvent(event);
		};
		const handle = original(issue, groupSlug, worktreePath, wrappedOnEvent, contextContent);
		pid = handle.pid;
		registry.register(pid);
		return handle;
	};
}

function wrapSpawnDirectWorker(
	original: SchedulerDeps['spawnDirectWorker'],
	registry: WorkerRegistry,
): SchedulerDeps['spawnDirectWorker'] {
	return (id, groupSlug, worktreePath, onEvent, prompt) => {
		let pid = -1;
		const wrappedOnEvent = (event: WorkerEvent): void => {
			if (event.event === 'exited') {
				registry.deregister(pid);
			}
			onEvent(event);
		};
		const handle = original(id, groupSlug, worktreePath, wrappedOnEvent, prompt);
		pid = handle.pid;
		registry.register(pid);
		return handle;
	};
}

export async function orchestrate(
	planPath: string,
	onProgress: ProgressCallback,
	overrides?: OrchestrateOverrides,
): Promise<AssignWorkResult> {
	const config = (overrides?.loadConfig ?? realLoadConfig)();
	const plan = await (overrides?.parsePlan ?? realParsePlan)(planPath);

	const rawDeps = overrides?.deps ?? buildRealDeps();
	const progressDeps = wrapWithProgress(rawDeps, onProgress);

	// Create worker PID registry for force shutdown
	const registry = createWorkerRegistry();

	// Build shouldShutdown callback for scheduler
	const shouldShutdown = () => readShutdownFile();

	// Resume detection: reconcile state with git before scheduling
	const mergedPRs = new Set<number>();
	const checkExistingState = overrides?.hasExistingState ?? hasExistingState;
	if (checkExistingState()) {
		onProgress('Resuming from previous state -- reconciling with git...');
		try {
			const gitState = await buildGitState(rawDeps.execCommand ?? realExecCommand);
			const resumeResult = await resumeFromState(gitState, rawDeps.execCommand ?? realExecCommand);
			for (const correction of resumeResult.corrections) {
				onProgress(`  Reconciled: ${correction.slug} -- ${correction.reason}`);
			}
			for (const mergedBranch of resumeResult.mergedBranches) {
				const matchingGroup = plan.groups.find((g) => g.branch === mergedBranch);
				if (matchingGroup) {
					mergedPRs.add(matchingGroup.pr_number);
					onProgress(`  Already merged: PR #${matchingGroup.pr_number} (${mergedBranch})`);
				}
			}
		} catch (err) {
			process.stderr.write(
				`[orchestrate] resume failed, continuing with fresh state: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	// Wire shutdown + registry into deps
	const trackedDeps: SchedulerDeps = {
		...progressDeps,
		shouldShutdown,
		spawnWorker: wrapSpawnWorker(progressDeps.spawnWorker, registry),
		spawnDirectWorker: wrapSpawnDirectWorker(progressDeps.spawnDirectWorker, registry),
	};

	const ready = getReadyGroups(plan, mergedPRs);
	const capped = ready.slice(0, config.max_concurrent_agents);
	for (const group of capped) {
		onProgress(`Starting PR ${group.pr_number}: ${group.title} [${group.branch}]`);
	}

	const result = await assignWork(plan, mergedPRs, config, trackedDeps);

	// Check if any group was interrupted by shutdown
	const shutdownGroup = result.results.find((r) => r.shutdown);
	if (shutdownGroup) {
		const signal = readShutdownFile();
		if (signal?.mode === 'force') {
			await forceKillAll(registry, rawDeps.killWorker ?? realKillWorker);
			overrides?.onShutdown?.('force');
		} else {
			overrides?.onShutdown?.('graceful');
		}
	}

	return result;
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
		createWorktree: realCreate,
		removeWorktree: realRemove,
		spawnWorker: realSpawnWorker,
		spawnDirectWorker: realSpawnDirectWorker,
		killWorker: realKillWorker,
		verify: realVerify,
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
