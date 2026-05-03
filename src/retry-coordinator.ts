import type { GroupStatus, OrchestratorConfig, WorkerCapableDeps, WorkerEvent } from './types.js';

export type RetryDeps = WorkerCapableDeps;

// --- Failure classification ---

export type FailureAction = 'retry' | 'needs-input';

export function classifyFailure(stepResult: string): FailureAction {
	// Worktree errors are infrastructure failures — no retry
	if (stepResult.startsWith('worktree error:')) {
		return 'needs-input';
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
	return 'needs-input';
}

// --- Retry coordinator ---

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

			if (classifyFailure(stepResult) === 'needs-input') {
				return escalate(issue, groupSlug, currentStatus, stepResult, config, deps, attempt, now);
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
					now,
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
					now,
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

		if (action === 'needs-input') {
			return escalate(issue, groupSlug, currentStatus, stepResult, config, deps, attempt, now);
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
		now,
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

export type BackoffResult<T> =
	| { readonly success: true; readonly result: T; readonly attempts: number }
	| { readonly success: false; readonly error: Error; readonly attempts: number };

export async function withBackoff<T>(
	fn: () => Promise<T>,
	options: BackoffOptions = DEFAULT_BACKOFF,
): Promise<BackoffResult<T>> {
	let lastError: Error = new Error('withBackoff: no attempts');
	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		try {
			const result = await fn();
			return { success: true, result, attempts: attempt };
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt === options.maxAttempts) {
				return { success: false, error: lastError, attempts: attempt };
			}
			const delay = options.baseDelayMs * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	return { success: false, error: lastError, attempts: options.maxAttempts };
}

function escalate(
	issue: number,
	groupSlug: string,
	currentStatus: GroupStatus,
	reason: string,
	config: OrchestratorConfig,
	deps: RetryDeps,
	attempts: number,
	now: () => string,
): RetryResult {
	deps.writeGroupStatus(groupSlug, {
		...currentStatus,
		step: 'idle',
		step_result: 'needs-input',
		last_updated: now(),
	});

	deps.notify(`${groupSlug} #${issue}: ${reason}`, config.notifications).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[retry-coordinator] notification failed: ${msg}\n`);
	});

	return {
		success: false,
		attempts,
		escalated: true,
		escalationReason: reason,
	};
}
