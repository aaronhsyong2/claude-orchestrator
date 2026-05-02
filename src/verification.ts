import { exec } from 'node:child_process';
import * as path from 'node:path';
import type { StepResult, VerifyCommand, VerifyResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Conventional exit code for timeout (matches `timeout` shell command)
const TIMEOUT_EXIT_CODE = 124;

/**
 * Execute verification commands serially with fail-fast behavior.
 * Commands are passed to /bin/sh via exec — they must originate from trusted
 * config (e.g. OrchestratorConfig.verify), never from user-controlled input.
 */
export async function verify(
	cwd: string,
	commands: readonly VerifyCommand[],
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerifyResult> {
	if (!cwd || !path.isAbsolute(cwd)) {
		throw new Error(`cwd must be an absolute path, got: "${cwd}"`);
	}

	const steps: StepResult[] = [];

	for (const cmd of commands) {
		const result = await runStep(cmd, cwd, timeoutMs);
		steps.push(result);

		if (result.exitCode !== 0) {
			return {
				success: false,
				failedStep: cmd.name,
				// Prefer stderr for error context; fall back to stdout if stderr is empty
				error: result.stderr || result.stdout,
				steps,
			};
		}
	}

	return { success: true, steps };
}

function runStep(cmd: VerifyCommand, cwd: string, timeoutMs: number): Promise<StepResult> {
	return new Promise((resolve) => {
		const start = Date.now();

		exec(cmd.command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
			const duration = Date.now() - start;

			let exitCode = 0;
			if (error) {
				const errObj = error as NodeJS.ErrnoException & {
					status?: number;
					killed?: boolean;
				};
				if (errObj.killed) {
					exitCode = TIMEOUT_EXIT_CODE;
				} else {
					exitCode = errObj.status ?? 1;
				}
			}

			resolve({
				name: cmd.name,
				command: cmd.command,
				exitCode,
				duration,
				stdout: stdout ?? '',
				stderr: stderr ?? '',
			});
		});
	});
}
