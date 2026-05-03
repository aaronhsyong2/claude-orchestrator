import type {
	GroupStatus,
	NotificationConfig,
	OrchestratorConfig,
	VerifyCommand,
	VerifyResult,
	WorkerEvent,
	WorkerHandle,
} from './types.js';

// --- Failure classification ---

export type FailureAction = 'retry' | 'notify' | 'needs_input';

export function classifyFailure(stepResult: string): FailureAction {
	// Worktree errors are infrastructure failures — no retry
	if (stepResult.startsWith('worktree error:')) {
		return 'needs_input';
	}

	// Verification failures and worker crashes are retryable
	if (
		stepResult.startsWith('failed:') ||
		stepResult.startsWith('worker exited with code') ||
		stepResult.startsWith('worker error:')
	) {
		return 'retry';
	}

	// Unknown failures — escalate
	return 'needs_input';
}

// --- Retry coordinator ---

export interface RetryDeps {
	readonly spawnWorker: (
		issue: string,
		groupSlug: string,
		worktreePath: string,
		onEvent: (event: WorkerEvent) => void,
		contextContent?: string,
	) => WorkerHandle;
	readonly verify: (cwd: string, commands: readonly VerifyCommand[]) => Promise<VerifyResult>;
	readonly readContext: (groupSlug: string, issue: string) => string | null;
	readonly writeContext: (groupSlug: string, issue: string, content: string) => void;
	readonly writeGroupStatus: (groupSlug: string, data: GroupStatus) => void;
	readonly notify: (message: string, config: NotificationConfig) => Promise<void>;
	readonly now?: () => string;
}

export interface RetryResult {
	readonly success: boolean;
	readonly attempts: number;
	readonly escalated: boolean;
	readonly escalationReason?: string;
}

function buildContextEntry(attempt: number, error: string): string {
	return `## Attempt ${attempt}\n\n**Error:** ${error}\n`;
}

/** Max consecutive crashes before escalating (retry once, fail on second). */
const MAX_CONSECUTIVE_CRASHES = 2;

export async function executeWithRetry(
	issue: number,
	groupSlug: string,
	worktreePath: string,
	currentStatus: GroupStatus,
	config: OrchestratorConfig,
	deps: RetryDeps,
): Promise<RetryResult> {
	const maxRetries = config.max_retries_on_fail;
	const now = deps.now ?? (() => new Date().toISOString());
	let attempt = 0;
	let consecutiveCrashes = 0;

	while (attempt <= maxRetries) {
		attempt++;

		// Read accumulated context from prior retries
		const contextContent = deps.readContext(groupSlug, String(issue)) ?? undefined;

		// Spawn worker and wait for exit
		let exitCode: number;
		try {
			exitCode = await new Promise<number>((resolve, reject) => {
				try {
					deps.spawnWorker(
						String(issue),
						groupSlug,
						worktreePath,
						(event: WorkerEvent) => {
							if (event.event === 'exited') resolve(event.data);
							if (event.event === 'error') reject(event.data);
						},
						contextContent,
					);
				} catch (err) {
					reject(err);
				}
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stepResult = `worker error: ${message}`;
			const action = classifyFailure(stepResult);

			if (action === 'needs_input') {
				return escalate(issue, groupSlug, currentStatus, stepResult, config, deps, attempt);
			}

			consecutiveCrashes++;
			if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
				return escalate(
					issue,
					groupSlug,
					currentStatus,
					`worker crashed ${consecutiveCrashes} times consecutively`,
					config,
					deps,
					attempt,
				);
			}

			appendContext(deps, groupSlug, issue, attempt, stepResult);
			continue;
		}

		if (exitCode !== 0) {
			consecutiveCrashes++;
			const stepResult = `worker exited with code ${exitCode}`;

			if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
				return escalate(
					issue,
					groupSlug,
					currentStatus,
					`worker crashed ${consecutiveCrashes} times consecutively`,
					config,
					deps,
					attempt,
				);
			}

			appendContext(deps, groupSlug, issue, attempt, stepResult);
			continue;
		}

		// Worker succeeded — reset crash counter
		consecutiveCrashes = 0;

		// Worker succeeded — run verification
		deps.writeGroupStatus(groupSlug, {
			...currentStatus,
			step: 'verifying',
			step_result: '',
			last_updated: now(),
		});

		const verifyResult = await deps.verify(worktreePath, config.verify);

		if (verifyResult.success) {
			return { success: true, attempts: attempt, escalated: false };
		}

		const stepResult = `failed: ${verifyResult.failedStep}`;
		const action = classifyFailure(stepResult);

		if (action === 'needs_input') {
			return escalate(issue, groupSlug, currentStatus, stepResult, config, deps, attempt);
		}

		// Append verification error details to context for next retry
		const errorDetail = verifyResult.error ? `${stepResult}\n\n${verifyResult.error}` : stepResult;
		appendContext(deps, groupSlug, issue, attempt, errorDetail);
	}

	// Exhausted retries
	return escalate(
		issue,
		groupSlug,
		currentStatus,
		`max retries exhausted (${maxRetries})`,
		config,
		deps,
		attempt,
	);
}

function appendContext(
	deps: RetryDeps,
	groupSlug: string,
	issue: number,
	attempt: number,
	error: string,
): void {
	const existing = deps.readContext(groupSlug, String(issue)) ?? '';
	const entry = buildContextEntry(attempt, error);
	const updated = existing ? `${existing}\n${entry}` : entry;
	deps.writeContext(groupSlug, String(issue), updated);
}

// --- Exponential backoff for external CLI commands ---

export interface BackoffOptions {
	readonly maxAttempts: number;
	readonly baseDelayMs: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { maxAttempts: 3, baseDelayMs: 1000 };

export async function withBackoff<T>(
	fn: () => Promise<T>,
	options: BackoffOptions = DEFAULT_BACKOFF,
): Promise<{ readonly success: boolean; readonly result?: T; readonly attempts: number }> {
	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		try {
			const result = await fn();
			return { success: true, result, attempts: attempt };
		} catch {
			if (attempt === options.maxAttempts) {
				return { success: false, attempts: attempt };
			}
			const delay = options.baseDelayMs * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	return { success: false, attempts: options.maxAttempts };
}

function escalate(
	issue: number,
	groupSlug: string,
	currentStatus: GroupStatus,
	reason: string,
	config: OrchestratorConfig,
	deps: RetryDeps,
	attempts: number,
): RetryResult {
	const now = deps.now ?? (() => new Date().toISOString());
	deps.writeGroupStatus(groupSlug, {
		...currentStatus,
		step: 'idle',
		step_result: 'needs-input',
		last_updated: now(),
	});

	void deps.notify(`${groupSlug} #${issue}: ${reason}`, config.notifications);

	return {
		success: false,
		attempts,
		escalated: true,
		escalationReason: reason,
	};
}
