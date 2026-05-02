import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
	NdjsonAssistantMessage,
	NdjsonMessage,
	NdjsonResultMessage,
	NdjsonSystemMessage,
	WorkerEventType,
	WorkerHandle,
} from './types.js';
import { assertValidIssue, assertValidSlug } from './validation.js';

const KILL_TIMEOUT_MS = 5000;
const KILL_POLL_INTERVAL_MS = 100;

export function buildPrompt(issueNumber: string, contextContent?: string): string {
	const base = `/pick-up #${issueNumber}`;
	if (!contextContent) return base;
	return `${base}\n\nContext from previous attempt:\n${contextContent}`;
}

export function getLogDir(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug);
}

export function getLogPath(groupSlug: string, issue: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug, `${issue}.log`);
}

export function parseNdjsonLine(line: string): NdjsonMessage | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (typeof parsed !== 'object' || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;

	if (typeof obj.type !== 'string') return null;

	switch (obj.type) {
		case 'system':
			return {
				type: 'system',
				subtype: String(obj.subtype ?? ''),
				session_id: String(obj.session_id ?? ''),
			} satisfies NdjsonSystemMessage;
		case 'assistant':
			return {
				type: 'assistant',
				message: obj.message,
			} satisfies NdjsonAssistantMessage;
		case 'result':
			return {
				type: 'result',
				result: String(obj.result ?? ''),
				is_error: Boolean(obj.is_error),
			} satisfies NdjsonResultMessage;
		default:
			return null;
	}
}

export type WorkerEventCallback = (
	event: WorkerEventType,
	data: NdjsonMessage | number | Error,
) => void;

export function spawnWorker(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	onEvent: WorkerEventCallback,
	contextContent?: string,
	baseDir?: string,
): WorkerHandle {
	assertValidSlug(groupSlug);
	assertValidIssue(issue);

	if (!worktreePath || !path.isAbsolute(worktreePath)) {
		throw new Error(`worktreePath must be an absolute path, got: "${worktreePath}"`);
	}
	if (!fs.existsSync(worktreePath)) {
		throw new Error(`worktreePath does not exist: "${worktreePath}"`);
	}

	const prompt = buildPrompt(issue, contextContent);
	const logPath = getLogPath(groupSlug, issue, baseDir);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const logStream = fs.createWriteStream(logPath, { flags: 'a' });
	logStream.on('error', (err) => {
		process.stderr.write(`[worker-manager] log write error for ${logPath}: ${err.message}\n`);
	});

	const proc = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
		cwd: worktreePath,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ECC_HOOK_PROFILE: 'minimal', ECC_GATEGUARD: 'off' },
	});

	if (!proc.pid) {
		throw new Error('Failed to spawn claude — process has no PID');
	}

	const handle: WorkerHandle = {
		id: `${groupSlug}-${issue}`,
		issue,
		groupSlug,
		pid: proc.pid,
	};

	// Track whether we've already closed the log stream
	let logClosed = false;
	const closeLog = () => {
		if (!logClosed) {
			logClosed = true;
			logStream.end();
		}
	};

	// Parse NDJSON from stdout
	if (proc.stdout) {
		const rl = readline.createInterface({ input: proc.stdout });
		rl.on('line', (line) => {
			logStream.write(`${line}\n`);
			const msg = parseNdjsonLine(line);
			if (msg) {
				onEvent('message', msg);
			} else if (line.trim()) {
				process.stderr.write(
					`[worker-manager] unparseable NDJSON for ${groupSlug}/${issue}: ${line.slice(0, 120)}\n`,
				);
			}
		});
		rl.on('error', (err) => {
			process.stderr.write(
				`[worker-manager] readline error for ${groupSlug}/${issue}: ${err.message}\n`,
			);
			onEvent('error', err);
		});
	}

	// Capture stderr
	if (proc.stderr) {
		proc.stderr.on('data', (chunk: Buffer) => {
			logStream.write(`[stderr] ${chunk.toString()}`);
		});
	}

	// Handle spawn error (e.g., claude not in PATH)
	proc.on('error', (err) => {
		closeLog();
		onEvent('error', err);
	});

	// Handle exit — use 'close' to ensure streams are flushed
	proc.on('close', (code, signal) => {
		closeLog();
		if (code === null && signal) {
			process.stderr.write(
				`[worker-manager] worker ${groupSlug}/${issue} terminated by signal ${signal}\n`,
			);
		}
		onEvent('exited', code ?? 1);
	});

	// Defer spawned event so caller has the handle before any events fire
	process.nextTick(() => onEvent('spawned', 0));
	return handle;
}

export async function killWorker(pid: number): Promise<void> {
	try {
		process.kill(pid, 0);
	} catch {
		return; // Already dead
	}

	// Wrap SIGTERM in try/catch — process may die between liveness check and signal
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return; // Died between check and kill
	}

	const died = await waitForExit(pid, KILL_TIMEOUT_MS);
	if (!died) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already dead between SIGTERM and SIGKILL — no further polling needed
		}
	}
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			try {
				process.kill(pid, 0);
			} catch {
				resolve(true);
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				resolve(false);
				return;
			}
			setTimeout(check, KILL_POLL_INTERVAL_MS);
		};
		check();
	});
}
