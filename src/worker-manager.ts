import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { formatIssueContext, WORKER_CONSTRAINTS } from './issue-fetcher.js';
import { parseToolUseActivity } from './tui/observability.js';
import type {
	IssueContent,
	NdjsonAssistantMessage,
	NdjsonMessage,
	NdjsonResultMessage,
	NdjsonSystemMessage,
	SessionOptions,
	WorkerEvent,
	WorkerHandle,
} from './types.js';
import { assertValidIssue, assertValidSlug } from './validation.js';

const KILL_TIMEOUT_MS = 5000;
const KILL_POLL_INTERVAL_MS = 100;

export function buildPrompt(
	issueNumber: string,
	contextContent?: string,
	options?: { resume?: boolean; route?: string; issueContent?: IssueContent },
): string {
	const base = options?.route
		? `${options.route} #${issueNumber}`
		: `Implement issue #${issueNumber}`;

	const parts: string[] = [base];

	if (options?.issueContent) {
		parts.push('', formatIssueContext(options.issueContent));
		parts.push('', WORKER_CONSTRAINTS);
	}

	if (contextContent) {
		const label = options?.resume
			? 'Context from previous attempt (session resumed):'
			: 'Context from previous attempt:';
		parts.push('', `${label}\n${contextContent}`);
	}

	return parts.join('\n');
}

export function getLogDir(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug);
}

export function getLogPath(groupSlug: string, issue: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug, `${issue}.log`);
}

export function getReadableLogPath(groupSlug: string, issue: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/logs', groupSlug, `${issue}.readable.log`);
}

const VERBOSE_ONLY_TYPES = new Set(['user', 'rate_limit_event', 'tool_use', 'tool_result']);

/** Returns true if line is valid JSON with a known verbose-mode type (safe to ignore silently). */
function isKnownNdjsonType(line: string): boolean {
	try {
		const obj = JSON.parse(line.trim());
		return typeof obj?.type === 'string' && VERBOSE_ONLY_TYPES.has(obj.type);
	} catch {
		return false;
	}
}

const READABLE_LINE_MAX = 120;

/**
 * Convert a raw NDJSON line into a human-readable log string.
 * Returns null for types that should not appear in the readable log.
 */
export function formatReadableLine(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') return null;

	switch (obj.type) {
		case 'assistant':
			return formatAssistant(obj.message);
		case 'tool_use':
			return formatToolUse(obj.name as string, obj.input as Record<string, unknown> | undefined);
		case 'result':
			return obj.is_error
				? `[result] ERROR: ${String(obj.result ?? '')}`
				: `[result] ${String(obj.result ?? '')}`;
		case 'tool_result':
			if (obj.is_error) {
				const content = typeof obj.content === 'string' ? obj.content : String(obj.content ?? '');
				return `[tool_result] ERROR: ${content}`;
			}
			return null;
		default:
			return null;
	}
}

function formatAssistant(message: unknown): string | null {
	if (typeof message === 'string') {
		return message || null;
	}
	if (typeof message === 'object' && message !== null) {
		const msg = message as { content?: unknown[] };
		if (Array.isArray(msg.content)) {
			const texts = msg.content
				.filter(
					(block): block is { type: 'text'; text: string } =>
						typeof block === 'object' &&
						block !== null &&
						(block as Record<string, unknown>).type === 'text' &&
						typeof (block as Record<string, unknown>).text === 'string',
				)
				.map((block) => block.text);
			const joined = texts.join('');
			return joined || null;
		}
	}
	return null;
}

function formatToolUse(name: string, input?: Record<string, unknown>): string {
	if (input) {
		if (typeof input.file_path === 'string') {
			return `[tool] ${name} ${input.file_path}`;
		}
		if (typeof input.command === 'string') {
			const cmd = input.command as string;
			const summary = `[tool] ${name}: ${cmd}`;
			if (summary.length > READABLE_LINE_MAX) {
				return `${summary.slice(0, READABLE_LINE_MAX - 1)}…`;
			}
			return summary;
		}
	}
	return `[tool] ${name}`;
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

export type WorkerEventCallback = (event: WorkerEvent) => void;

// --- Shared spawn infrastructure ---

function assertValidWorktreePath(worktreePath: string): void {
	if (!worktreePath || !path.isAbsolute(worktreePath)) {
		throw new Error(`worktreePath must be an absolute path, got: "${worktreePath}"`);
	}
	if (!fs.existsSync(worktreePath)) {
		throw new Error(`worktreePath does not exist: "${worktreePath}"`);
	}
}

function spawnClaudeProcess(
	id: string,
	groupSlug: string,
	worktreePath: string,
	prompt: string,
	onEvent: WorkerEventCallback,
	baseDir?: string,
	session?: SessionOptions,
): WorkerHandle {
	const logPath = getLogPath(groupSlug, id, baseDir);
	const readableLogPath = getReadableLogPath(groupSlug, id, baseDir);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const logStream = fs.createWriteStream(logPath, { flags: 'a' });
	logStream.on('error', (err) => {
		process.stderr.write(`[worker-manager] log write error for ${logPath}: ${err.message}\n`);
	});
	const readableLogStream = fs.createWriteStream(readableLogPath, { flags: 'a' });
	readableLogStream.on('error', (err) => {
		process.stderr.write(
			`[worker-manager] readable log write error for ${readableLogPath}: ${err.message}\n`,
		);
	});

	const sessionArgs: string[] = [];
	if (session?.sessionId) {
		if (session.resume) {
			sessionArgs.push('--resume', session.sessionId);
		} else {
			sessionArgs.push('--session-id', session.sessionId);
		}
	}

	const proc = spawn(
		'claude',
		[...sessionArgs, '-p', '--verbose', '--output-format', 'stream-json', prompt],
		{
			cwd: worktreePath,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ECC_HOOK_PROFILE: 'minimal', ECC_GATEGUARD: 'off' },
		},
	);

	if (!proc.pid) {
		throw new Error('Failed to spawn claude — process has no PID');
	}

	const handle: WorkerHandle = {
		id: `${groupSlug}-${id}`,
		issue: id,
		groupSlug,
		pid: proc.pid,
		...(session?.sessionId ? { sessionId: session.sessionId } : {}),
	};

	let logClosed = false;
	const closeLog = () => {
		if (!logClosed) {
			logClosed = true;
			logStream.end();
			readableLogStream.end();
		}
	};

	if (proc.stdout) {
		const rl = readline.createInterface({ input: proc.stdout });
		rl.on('line', (line) => {
			logStream.write(`${line}\n`);

			const readable = formatReadableLine(line);
			if (readable) {
				readableLogStream.write(`${readable}\n`);
			}

			const activity = parseToolUseActivity(line);
			if (activity) {
				onEvent({ event: 'tool_activity', data: activity });
			}

			const msg = parseNdjsonLine(line);
			if (msg) {
				onEvent({ event: 'message', data: msg });
			} else if (line.trim() && !isKnownNdjsonType(line)) {
				process.stderr.write(
					`[worker-manager] unparseable NDJSON for ${groupSlug}/${id}: ${line.slice(0, 120)}\n`,
				);
			}
		});
		rl.on('error', (err) => {
			process.stderr.write(
				`[worker-manager] readline error for ${groupSlug}/${id}: ${err.message}\n`,
			);
			onEvent({ event: 'error', data: err });
		});
	}

	if (proc.stderr) {
		proc.stderr.on('data', (chunk: Buffer) => {
			logStream.write(`[stderr] ${chunk.toString()}`);
		});
	}

	proc.on('error', (err) => {
		closeLog();
		onEvent({ event: 'error', data: err });
	});

	proc.on('close', (code, signal) => {
		closeLog();
		if (code === null && signal) {
			process.stderr.write(
				`[worker-manager] worker ${groupSlug}/${id} terminated by signal ${signal}\n`,
			);
		}
		onEvent({ event: 'exited', data: code ?? 1 });
	});

	process.nextTick(() => onEvent({ event: 'spawned' }));
	return handle;
}

// --- Public spawn functions ---

export function spawnWorker(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	onEvent: WorkerEventCallback,
	contextContent?: string,
	baseDir?: string,
	session?: SessionOptions,
	issueContent?: IssueContent,
): WorkerHandle {
	assertValidSlug(groupSlug);
	assertValidIssue(issue);
	assertValidWorktreePath(worktreePath);

	const prompt = buildPrompt(issue, contextContent, {
		resume: session?.resume,
		issueContent,
	});
	return spawnClaudeProcess(issue, groupSlug, worktreePath, prompt, onEvent, baseDir, session);
}

/**
 * Spawn a Claude worker with a direct prompt (no routing or issue wrapping).
 * Used for review and fix workers that don't correspond to a numeric issue.
 */
export function spawnDirectWorker(
	id: string,
	groupSlug: string,
	worktreePath: string,
	onEvent: WorkerEventCallback,
	prompt: string,
	baseDir?: string,
): WorkerHandle {
	assertValidSlug(groupSlug);
	assertValidWorktreePath(worktreePath);

	return spawnClaudeProcess(id, groupSlug, worktreePath, prompt, onEvent, baseDir);
}

// --- Kill ---

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
