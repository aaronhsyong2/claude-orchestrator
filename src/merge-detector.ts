import type {
	MergeDetectorDeps,
	MergeDetectorHandle,
	MergeDetectorResult,
	MergeDetectorState,
} from './types.js';

/** GitHub API poll interval (10s) — primary detection path. */
const GITHUB_POLL_INTERVAL_MS = 10_000;
/** Git fallback poll interval (5s) — faster to compensate for weaker heuristic. */
const GIT_FALLBACK_INTERVAL_MS = 5_000;
/** Recovery poll interval (60s) — infrequent probe to detect GitHub API recovery. */
const RECOVERY_POLL_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export { GIT_FALLBACK_INTERVAL_MS, GITHUB_POLL_INTERVAL_MS, RECOVERY_POLL_INTERVAL_MS };

export interface MergeDetectorOptions {
	readonly githubPollMs?: number;
	readonly gitFallbackMs?: number;
	readonly recoveryPollMs?: number;
	readonly maxWaitMs?: number;
}

export type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

export function startMergeDetector(
	prNumber: number,
	branch: string,
	baseBranch: string,
	cwd: string,
	onComplete: (result: MergeDetectorResult) => void,
	deps: MergeDetectorDeps,
	options?: MergeDetectorOptions,
): MergeDetectorHandle {
	const githubPollMs = options?.githubPollMs ?? GITHUB_POLL_INTERVAL_MS;
	const gitFallbackMs = options?.gitFallbackMs ?? GIT_FALLBACK_INTERVAL_MS;
	const recoveryPollMs = options?.recoveryPollMs ?? RECOVERY_POLL_INTERVAL_MS;

	let stopped = false;
	let completed = false;
	let state: MergeDetectorState = 'GITHUB_POLLING';
	let consecutiveFailures = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

	function complete(result: MergeDetectorResult): void {
		if (completed || stopped) return;
		completed = true;
		clearTimers();
		onComplete(result);
	}

	function clearTimers(): void {
		if (pollTimer !== null) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (recoveryTimer !== null) {
			clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
		if (timeoutTimer !== null) {
			clearTimeout(timeoutTimer);
			timeoutTimer = null;
		}
	}

	async function pollGitHub(): Promise<void> {
		if (stopped || completed) return;

		try {
			const result = await deps.execCommand(
				'gh',
				['pr', 'view', String(prNumber), '--json', 'state'],
				cwd,
			);

			if (stopped || completed) return;

			if (result.exitCode !== 0) {
				handleGitHubFailure();
				return;
			}

			const parsed = parsePRState(result.stdout);
			if (parsed === null) {
				handleGitHubFailure();
				return;
			}

			// Valid response — reset failure counter
			consecutiveFailures = 0;

			if (parsed === 'MERGED') {
				complete('merged');
				return;
			}

			if (parsed === 'CLOSED') {
				complete('closed');
				return;
			}

			schedulePoll();
		} catch (err) {
			if (stopped || completed) return;
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[merge-detector] PR #${prNumber}: poll error: ${msg}\n`);
			handleGitHubFailure();
		}
	}

	async function pollGit(): Promise<void> {
		if (stopped || completed) return;

		try {
			const fetchResult = await deps.execCommand('git', ['fetch', '--prune', 'origin'], cwd);
			if (stopped || completed) return;

			if (fetchResult.exitCode !== 0) {
				process.stderr.write(
					`[merge-detector] PR #${prNumber}: git fetch failed (exit ${fetchResult.exitCode})\n`,
				);
				schedulePoll();
				return;
			}

			const merged = await checkMergedViaGit();
			if (stopped || completed) return;
			if (merged) {
				complete('merged');
				return;
			}

			schedulePoll();
		} catch (err) {
			if (stopped || completed) return;
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[merge-detector] PR #${prNumber}: git poll error: ${msg}\n`);
			schedulePoll();
		}
	}

	async function checkMergedViaGit(): Promise<boolean> {
		// Check if branch ref still exists on remote
		const lsResult = await deps.execCommand('git', ['ls-remote', '--heads', 'origin', branch], cwd);
		if (lsResult.exitCode !== 0 || lsResult.stdout.trim() !== '') {
			// Branch still exists or ls-remote failed — not merged
			return false;
		}

		// Branch gone from remote — verify the local branch tip is an ancestor of base.
		// We use the local branch ref (which exists in the worktree) since --prune
		// removes the remote tracking ref. Exit 0 = ancestor (merged), 1 = not.
		const ancestorCheck = await deps.execCommand(
			'git',
			['merge-base', '--is-ancestor', branch, `origin/${baseBranch}`],
			cwd,
		);
		return ancestorCheck.exitCode === 0;
	}

	async function recoveryPoll(): Promise<void> {
		if (stopped || completed || state !== 'GIT_FALLBACK') return;

		try {
			const result = await deps.execCommand(
				'gh',
				['pr', 'view', String(prNumber), '--json', 'state'],
				cwd,
			);

			if (stopped || completed) return;

			if (result.exitCode === 0) {
				const parsed = parsePRState(result.stdout);
				if (parsed === 'MERGED') {
					complete('merged');
					return;
				}
				if (parsed === 'CLOSED') {
					complete('closed');
					return;
				}
				if (parsed !== null) {
					// GitHub recovered — switch back
					transitionToGitHubPolling();
					return;
				}
			}

			// Still failing — schedule next recovery attempt
			scheduleRecovery();
		} catch (err) {
			if (stopped || completed) return;
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[merge-detector] PR #${prNumber}: recovery poll error: ${msg}\n`);
			scheduleRecovery();
		}
	}

	function transitionToGitFallback(): void {
		state = 'GIT_FALLBACK';
		process.stderr.write(
			`[merge-detector] PR #${prNumber}: switching to git fallback after ${MAX_CONSECUTIVE_FAILURES} failures\n`,
		);
		schedulePoll();
		scheduleRecovery();
	}

	function transitionToGitHubPolling(): void {
		state = 'GITHUB_POLLING';
		consecutiveFailures = 0;
		process.stderr.write(
			`[merge-detector] PR #${prNumber}: GitHub recovered, switching back to API polling\n`,
		);
		if (recoveryTimer !== null) {
			clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
		schedulePoll();
	}

	function handleGitHubFailure(): void {
		consecutiveFailures++;
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			transitionToGitFallback();
		} else {
			schedulePoll();
		}
	}

	function schedulePoll(): void {
		if (stopped || completed) return;
		if (pollTimer !== null) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		const interval = state === 'GITHUB_POLLING' ? githubPollMs : gitFallbackMs;
		pollTimer = setTimeout(() => {
			if (state === 'GITHUB_POLLING') {
				void pollGitHub();
			} else {
				void pollGit();
			}
		}, interval);
	}

	function scheduleRecovery(): void {
		if (stopped || completed) return;
		if (recoveryTimer !== null) {
			clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
		recoveryTimer = setTimeout(() => {
			void recoveryPoll();
		}, recoveryPollMs);
	}

	// Start timeout timer if configured
	if (options?.maxWaitMs !== undefined) {
		timeoutTimer = setTimeout(() => {
			complete('timeout');
		}, options.maxWaitMs);
	}

	// Start initial poll
	void pollGitHub();

	return {
		stop: () => {
			stopped = true;
			clearTimers();
		},
	};
}

export function parsePRState(stdout: string): PRState | null {
	try {
		const parsed = JSON.parse(stdout.trim()) as { state?: string };
		const state = parsed.state;
		if (state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') {
			return state;
		}
		return null;
	} catch {
		return null;
	}
}
