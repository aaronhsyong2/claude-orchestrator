import type { MergeDetectorDeps, MergeDetectorHandle, MergeDetectorState } from './types.js';

const GITHUB_POLL_INTERVAL_MS = 10_000;
const GIT_FALLBACK_INTERVAL_MS = 5_000;
const RECOVERY_POLL_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export { GIT_FALLBACK_INTERVAL_MS, GITHUB_POLL_INTERVAL_MS, RECOVERY_POLL_INTERVAL_MS };

export interface MergeDetectorOptions {
	readonly githubPollMs?: number;
	readonly gitFallbackMs?: number;
	readonly recoveryPollMs?: number;
}

export function startMergeDetector(
	prNumber: number,
	branch: string,
	cwd: string,
	onMerge: () => void,
	deps: MergeDetectorDeps,
	options?: MergeDetectorOptions,
): MergeDetectorHandle {
	const githubPollMs = options?.githubPollMs ?? GITHUB_POLL_INTERVAL_MS;
	const gitFallbackMs = options?.gitFallbackMs ?? GIT_FALLBACK_INTERVAL_MS;
	const recoveryPollMs = options?.recoveryPollMs ?? RECOVERY_POLL_INTERVAL_MS;

	let stopped = false;
	let state: MergeDetectorState = 'GITHUB_POLLING';
	let consecutiveFailures = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimers(): void {
		if (pollTimer !== null) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (recoveryTimer !== null) {
			clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
	}

	async function pollGitHub(): Promise<void> {
		if (stopped) return;

		const result = await deps.execCommand(
			'gh',
			['pr', 'view', String(prNumber), '--json', 'state'],
			cwd,
		);

		if (stopped) return;

		if (result.exitCode !== 0) {
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				transitionToGitFallback();
				return;
			}
			schedulePoll();
			return;
		}

		consecutiveFailures = 0;

		const parsed = parsePRState(result.stdout);
		if (parsed === 'MERGED') {
			onMerge();
			return;
		}

		schedulePoll();
	}

	async function pollGit(): Promise<void> {
		if (stopped) return;

		const fetchResult = await deps.execCommand('git', ['fetch', 'origin'], cwd);
		if (stopped) return;

		if (fetchResult.exitCode === 0) {
			const merged = await checkMergedViaGit();
			if (stopped) return;
			if (merged) {
				onMerge();
				return;
			}
		}

		schedulePoll();
	}

	async function checkMergedViaGit(): Promise<boolean> {
		// Check if the branch ref has been deleted on remote (merged + branch deleted)
		const lsResult = await deps.execCommand('git', ['ls-remote', '--heads', 'origin', branch], cwd);
		if (lsResult.exitCode === 0 && lsResult.stdout.trim() === '') {
			// Remote branch gone — likely merged and deleted
			return true;
		}
		return false;
	}

	async function recoveryPoll(): Promise<void> {
		if (stopped || state !== 'GIT_FALLBACK') return;

		const result = await deps.execCommand(
			'gh',
			['pr', 'view', String(prNumber), '--json', 'state'],
			cwd,
		);

		if (stopped) return;

		if (result.exitCode === 0) {
			const parsed = parsePRState(result.stdout);
			if (parsed === 'MERGED') {
				onMerge();
				return;
			}
			// GitHub recovered — switch back
			transitionToGitHubPolling();
			return;
		}

		// Still failing — schedule next recovery attempt
		scheduleRecovery();
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

	function schedulePoll(): void {
		if (stopped) return;
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
		if (stopped) return;
		recoveryTimer = setTimeout(() => {
			void recoveryPoll();
		}, recoveryPollMs);
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

function parsePRState(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout.trim()) as { state?: string };
		return parsed.state ?? null;
	} catch {
		return null;
	}
}
