import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { StepResult, VerifyCommand, VerifyResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Conventional exit code for timeout (matches `timeout` shell command)
const TIMEOUT_EXIT_CODE = 124;

/** Only allow safe characters in verify commands to prevent injection via compromised config. */
const SAFE_COMMAND_RE = /^[a-zA-Z0-9 _\-./=,@:]+$/;

/** Executables that delegate to a shell — block these as the first token in verify commands. */
const SHELL_EXECUTABLES = new Set([
	'sh',
	'bash',
	'zsh',
	'ksh',
	'csh',
	'tcsh',
	'fish',
	'dash',
	'python',
	'python3',
	'ruby',
	'perl',
	'node',
	'bun',
	'deno',
	'tsx',
	'ts-node',
	'env',
	'xargs',
	'lua',
	'awk',
	'/bin/sh',
	'/bin/bash',
	'/usr/bin/env',
]);

/**
 * Execute verification commands serially with fail-fast behavior.
 * Commands are split into argv and run via execFile (no shell interpolation).
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
		if (!SAFE_COMMAND_RE.test(cmd.command)) {
			throw new Error(`Verify command "${cmd.name}" contains unsafe characters: "${cmd.command}"`);
		}

		const parsed = splitCommand(cmd.command);
		const basename = parsed.file.split('/').pop() ?? parsed.file;
		if (SHELL_EXECUTABLES.has(parsed.file) || SHELL_EXECUTABLES.has(basename)) {
			throw new Error(
				`Verify command "${cmd.name}" uses shell-delegation executable "${parsed.file}" — use a direct executable instead`,
			);
		}

		const result = await runStep(cmd, parsed, cwd, timeoutMs);
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

function splitCommand(command: string): { file: string; args: string[] } {
	const parts = command.trim().split(/\s+/);
	if (!parts[0]) {
		throw new Error(`Command "${command}" has no executable after parsing`);
	}
	return { file: parts[0], args: parts.slice(1) };
}

function runStep(
	cmd: VerifyCommand,
	parsed: { file: string; args: string[] },
	cwd: string,
	timeoutMs: number,
): Promise<StepResult> {
	return new Promise((resolve) => {
		const start = Date.now();
		const { file, args } = parsed;

		execFile(file, args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
			const duration = Date.now() - start;

			let exitCode = 0;
			let resolvedStderr = stderr ?? '';
			if (error) {
				const errObj = error as NodeJS.ErrnoException & {
					status?: number;
					killed?: boolean;
				};
				if (errObj.killed) {
					exitCode = TIMEOUT_EXIT_CODE;
				} else if (errObj.code === 'ENOENT') {
					exitCode = 127;
					if (!resolvedStderr) {
						resolvedStderr = `Command not found: ${file}`;
					}
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
				stderr: resolvedStderr,
			});
		});
	});
}
