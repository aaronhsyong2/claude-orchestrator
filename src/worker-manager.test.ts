import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NdjsonMessage, WorkerEvent } from './types.js';
import {
	buildPrompt,
	formatReadableLine,
	getLogDir,
	getLogPath,
	getReadableLogPath,
	killWorker,
	parseNdjsonLine,
	spawnWorker,
} from './worker-manager.js';

// Mock child_process.spawn
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(childProcess.spawn);

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worker-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// --- Helper: create a fake ChildProcess ---

interface FakeProc extends EventEmitter {
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	readonly pid: number;
	readonly stdin: null;
}

function createFakeProc(pid: number | undefined = 12345): FakeProc {
	const proc = new EventEmitter() as FakeProc;
	Object.defineProperty(proc, 'stdout', { value: new PassThrough() });
	Object.defineProperty(proc, 'stderr', { value: new PassThrough() });
	Object.defineProperty(proc, 'pid', { value: pid, configurable: true });
	Object.defineProperty(proc, 'stdin', { value: null });
	return proc;
}

describe('buildPrompt', () => {
	it('builds basic prompt without context', () => {
		expect(buildPrompt('10')).toBe('/pick-up #10');
	});

	it('builds prompt with context', () => {
		const result = buildPrompt('10', 'Previous approach failed due to X');
		expect(result).toBe(
			'/pick-up #10\n\nContext from previous attempt:\nPrevious approach failed due to X',
		);
	});

	it('handles empty context as no context', () => {
		expect(buildPrompt('5', '')).toBe('/pick-up #5');
	});
});

describe('getLogDir', () => {
	it('returns .orchestrator/logs/<group> under baseDir', () => {
		const result = getLogDir('pr-1', '/repo');
		expect(result).toBe(path.resolve('/repo', '.orchestrator/logs/pr-1'));
	});

	it('defaults to cwd when no baseDir', () => {
		const result = getLogDir('pr-1');
		expect(result).toBe(path.resolve('.', '.orchestrator/logs/pr-1'));
	});
});

describe('getLogPath', () => {
	it('returns log file path for group and issue', () => {
		const result = getLogPath('pr-1', '10', '/repo');
		expect(result).toBe(path.resolve('/repo', '.orchestrator/logs/pr-1/10.log'));
	});
});

describe('getReadableLogPath', () => {
	it('returns .readable.log path for group and issue', () => {
		const result = getReadableLogPath('pr-1', '10', '/repo');
		expect(result).toBe(path.resolve('/repo', '.orchestrator/logs/pr-1/10.readable.log'));
	});

	it('defaults to cwd when no baseDir', () => {
		const result = getReadableLogPath('pr-1', '10');
		expect(result).toBe(path.resolve('.', '.orchestrator/logs/pr-1/10.readable.log'));
	});
});

describe('parseNdjsonLine', () => {
	it('parses system/init message', () => {
		const line = '{"type":"system","subtype":"init","session_id":"abc-123"}';
		const result = parseNdjsonLine(line);
		expect(result).toEqual({
			type: 'system',
			subtype: 'init',
			session_id: 'abc-123',
		});
	});

	it('parses assistant message with string content', () => {
		const line = '{"type":"assistant","message":"Working on the implementation"}';
		const result = parseNdjsonLine(line);
		expect(result).toEqual({
			type: 'assistant',
			message: 'Working on the implementation',
		});
	});

	it('parses assistant message with object content (Claude protocol)', () => {
		const line =
			'{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"hello"}]}}';
		const result = parseNdjsonLine(line);
		expect(result).toEqual({
			type: 'assistant',
			message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] },
		});
	});

	it('parses result message', () => {
		const line = '{"type":"result","result":"Done","is_error":false}';
		const result = parseNdjsonLine(line);
		expect(result).toEqual({
			type: 'result',
			result: 'Done',
			is_error: false,
		});
	});

	it('parses result message with error', () => {
		const line = '{"type":"result","result":"Failed","is_error":true}';
		const result = parseNdjsonLine(line);
		expect(result).toEqual({
			type: 'result',
			result: 'Failed',
			is_error: true,
		});
	});

	it('returns null for empty line', () => {
		expect(parseNdjsonLine('')).toBeNull();
		expect(parseNdjsonLine('  ')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(parseNdjsonLine('not json at all')).toBeNull();
	});

	it('returns null for unknown message type', () => {
		expect(parseNdjsonLine('{"type":"unknown","data":"value"}')).toBeNull();
	});

	it('returns null for missing type field', () => {
		expect(parseNdjsonLine('{"data":"value"}')).toBeNull();
	});

	it('returns null for non-object JSON', () => {
		expect(parseNdjsonLine('"just a string"')).toBeNull();
		expect(parseNdjsonLine('42')).toBeNull();
		expect(parseNdjsonLine('null')).toBeNull();
	});

	it('handles missing optional fields with defaults', () => {
		const result = parseNdjsonLine('{"type":"system"}');
		expect(result).toEqual({
			type: 'system',
			subtype: '',
			session_id: '',
		});
	});
});

describe('formatReadableLine', () => {
	it('extracts text from assistant message with string content', () => {
		const line = '{"type":"assistant","message":"Working on implementation"}';
		expect(formatReadableLine(line)).toBe('Working on implementation');
	});

	it('extracts text from assistant message with Claude protocol object', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'msg_1',
				content: [
					{ type: 'text', text: 'Reading the file now' },
					{ type: 'text', text: ' and checking types' },
				],
			},
		});
		expect(formatReadableLine(line)).toBe('Reading the file now and checking types');
	});

	it('formats tool_use with tool name and file path input', () => {
		const line = JSON.stringify({
			type: 'tool_use',
			name: 'Read',
			input: { file_path: 'src/types.ts' },
		});
		expect(formatReadableLine(line)).toBe('[tool] Read src/types.ts');
	});

	it('formats tool_use Edit with file path', () => {
		const line = JSON.stringify({
			type: 'tool_use',
			name: 'Edit',
			input: { file_path: 'src/foo.ts' },
		});
		expect(formatReadableLine(line)).toBe('[tool] Edit src/foo.ts');
	});

	it('formats tool_use Bash with command summary', () => {
		const line = JSON.stringify({
			type: 'tool_use',
			name: 'Bash',
			input: { command: 'git status' },
		});
		expect(formatReadableLine(line)).toBe('[tool] Bash: git status');
	});

	it('truncates long Bash commands', () => {
		const longCmd = 'a'.repeat(200);
		const line = JSON.stringify({
			type: 'tool_use',
			name: 'Bash',
			input: { command: longCmd },
		});
		const result = formatReadableLine(line);
		expect(result?.length).toBeLessThanOrEqual(120);
		expect(result).toContain('…');
	});

	it('formats tool_use with just name when no recognizable input', () => {
		const line = JSON.stringify({
			type: 'tool_use',
			name: 'WebSearch',
			input: { query: 'something' },
		});
		expect(formatReadableLine(line)).toBe('[tool] WebSearch');
	});

	it('formats result message', () => {
		const line = '{"type":"result","result":"Done","is_error":false}';
		expect(formatReadableLine(line)).toBe('[result] Done');
	});

	it('formats error result message', () => {
		const line = '{"type":"result","result":"Failed to complete","is_error":true}';
		expect(formatReadableLine(line)).toBe('[result] ERROR: Failed to complete');
	});

	it('returns null for system messages', () => {
		const line = '{"type":"system","subtype":"init","session_id":"abc"}';
		expect(formatReadableLine(line)).toBeNull();
	});

	it('returns null for rate_limit_event', () => {
		const line = '{"type":"rate_limit_event"}';
		expect(formatReadableLine(line)).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(formatReadableLine('not json')).toBeNull();
	});

	it('returns null for empty line', () => {
		expect(formatReadableLine('')).toBeNull();
		expect(formatReadableLine('  ')).toBeNull();
	});

	it('returns null for tool_result type', () => {
		const line = '{"type":"tool_result","content":"some output"}';
		expect(formatReadableLine(line)).toBeNull();
	});

	it('skips assistant messages with empty text', () => {
		const line = '{"type":"assistant","message":""}';
		expect(formatReadableLine(line)).toBeNull();
	});

	it('skips assistant protocol messages with no text content', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Read' }] },
		});
		expect(formatReadableLine(line)).toBeNull();
	});
});

describe('spawnWorker', () => {
	type EventEntry = WorkerEvent;

	let activeProc: FakeProc | null = null;

	afterEach(() => {
		// Ensure log streams are flushed before tmpDir cleanup
		if (activeProc) {
			if (!activeProc.stdout.destroyed) activeProc.stdout.end();
			if (!activeProc.stderr.destroyed) activeProc.stderr.end();
			activeProc.emit('close', 0);
			activeProc = null;
		}
	});

	function collect() {
		const events: EventEntry[] = [];
		const cb = (e: WorkerEvent) => events.push(e);
		return { events, cb };
	}

	function setupProc(pid = 12345) {
		const proc = createFakeProc(pid);
		spawnMock.mockReturnValue(proc as unknown as childProcess.ChildProcess);
		activeProc = proc;
		return proc;
	}

	it('rejects invalid groupSlug', () => {
		setupProc();
		expect(() => spawnWorker('10', '../evil', tmpDir, () => {}, undefined, tmpDir)).toThrow(
			/Invalid slug/,
		);
	});

	it('rejects invalid issue number', () => {
		setupProc();
		expect(() => spawnWorker('abc', 'pr-1', tmpDir, () => {}, undefined, tmpDir)).toThrow(
			/Invalid issue number/,
		);
	});

	it('rejects relative worktreePath', () => {
		setupProc();
		expect(() => spawnWorker('10', 'pr-1', 'relative/path', () => {}, undefined, tmpDir)).toThrow(
			/must be an absolute path/,
		);
	});

	it('rejects non-existent worktreePath', () => {
		setupProc();
		expect(() =>
			spawnWorker('10', 'pr-1', '/nonexistent/path', () => {}, undefined, tmpDir),
		).toThrow(/does not exist/);
	});

	it('throws when spawn returns no PID', () => {
		const proc = createFakeProc();
		// Override pid to undefined after creation
		Object.defineProperty(proc, 'pid', { value: undefined, configurable: true });
		spawnMock.mockReturnValue(proc as unknown as childProcess.ChildProcess);
		activeProc = proc;

		expect(() => spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir)).toThrow(
			/process has no PID/,
		);
	});

	it('spawns claude with correct args and env', () => {
		setupProc();
		const { cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			['-p', '--verbose', '--output-format', 'stream-json', '/pick-up #10'],
			expect.objectContaining({
				cwd: tmpDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: expect.objectContaining({
					ECC_HOOK_PROFILE: 'minimal',
					ECC_GATEGUARD: 'off',
				}),
			}),
		);
	});

	it('emits spawned event via nextTick', async () => {
		setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		// spawned is deferred via process.nextTick
		await new Promise((r) => process.nextTick(r));
		expect(events[0]).toEqual({ event: 'spawned' });
	});

	it('returns correct WorkerHandle', () => {
		setupProc(9999);

		const handle = spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir);

		expect(handle.id).toBe('pr-1-10');
		expect(handle.issue).toBe('10');
		expect(handle.groupSlug).toBe('pr-1');
		expect(handle.pid).toBe(9999);
	});

	it('parses NDJSON from stdout and emits message events', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.stdout.write('{"type":"system","subtype":"init","session_id":"s1"}\n');
		proc.stdout.write('{"type":"assistant","message":"working"}\n');
		proc.stdout.write('{"type":"result","result":"done","is_error":false}\n');

		await new Promise((r) => setTimeout(r, 50));

		const msgs = events.filter((e) => e.event === 'message');
		expect(msgs).toHaveLength(3);
		expect((msgs[0]?.data as NdjsonMessage).type).toBe('system');
		expect((msgs[1]?.data as NdjsonMessage).type).toBe('assistant');
		expect((msgs[2]?.data as NdjsonMessage).type).toBe('result');
	});

	it('writes raw output to log file', async () => {
		const proc = setupProc();

		spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir);

		proc.stdout.write('{"type":"assistant","message":"hello"}\n');
		await new Promise((r) => setTimeout(r, 50));

		proc.emit('close', 0);
		await new Promise((r) => setTimeout(r, 50));

		const logContent = fs.readFileSync(getLogPath('pr-1', '10', tmpDir), 'utf-8');
		expect(logContent).toContain('{"type":"assistant","message":"hello"}');
	});

	it('emits exited event on process close', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.emit('close', 0);
		await new Promise((r) => setTimeout(r, 10));

		const exitEvent = events.find((e) => e.event === 'exited');
		expect(exitEvent).toBeDefined();
		expect(exitEvent?.data).toBe(0);
	});

	it('emits exited with code 1 on null exit code', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.emit('close', null);
		await new Promise((r) => setTimeout(r, 10));

		const exitEvent = events.find((e) => e.event === 'exited');
		expect(exitEvent?.data).toBe(1);
	});

	it('emits error event when spawn fails', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		const err = new Error('spawn claude ENOENT');
		proc.emit('error', err);
		await new Promise((r) => setTimeout(r, 10));

		const errorEvent = events.find((e) => e.event === 'error');
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.data).toBe(err);
	});

	it('constructs prompt with context content', () => {
		setupProc();

		spawnWorker('10', 'pr-1', tmpDir, () => {}, 'Previous context here', tmpDir);

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			[
				'-p',
				'--verbose',
				'--output-format',
				'stream-json',
				'/pick-up #10\n\nContext from previous attempt:\nPrevious context here',
			],
			expect.anything(),
		);
	});

	it('emits tool_activity events for tool_use NDJSON lines', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.stdout.write('{"type":"tool_use","name":"Read","input":{"file_path":"src/types.ts"}}\n');
		proc.stdout.write('{"type":"tool_use","name":"Bash","input":{"command":"pnpm run test"}}\n');
		await new Promise((r) => setTimeout(r, 50));

		const activityEvents = events.filter((e) => e.event === 'tool_activity');
		expect(activityEvents).toHaveLength(2);
		expect(activityEvents[0]?.data).toBe('Reading src/types.ts');
		expect(activityEvents[1]?.data).toBe('Running pnpm run test');
	});

	it('does not emit tool_activity for non-tool_use types', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.stdout.write('{"type":"assistant","message":"working"}\n');
		proc.stdout.write('{"type":"result","result":"done","is_error":false}\n');
		await new Promise((r) => setTimeout(r, 50));

		const activityEvents = events.filter((e) => e.event === 'tool_activity');
		expect(activityEvents).toHaveLength(0);
	});

	it('skips invalid NDJSON lines without crashing', async () => {
		const proc = setupProc();
		const { events, cb } = collect();

		spawnWorker('10', 'pr-1', tmpDir, cb, undefined, tmpDir);

		proc.stdout.write('not valid json\n');
		proc.stdout.write('{"type":"assistant","message":"ok"}\n');
		await new Promise((r) => setTimeout(r, 50));

		const msgs = events.filter((e) => e.event === 'message');
		expect(msgs).toHaveLength(1);
		expect((msgs[0]?.data as NdjsonMessage).type).toBe('assistant');
	});

	it('creates log directory if it does not exist', () => {
		setupProc();

		spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir);

		expect(fs.existsSync(getLogDir('pr-1', tmpDir))).toBe(true);
	});

	it('writes readable log alongside raw log', async () => {
		const proc = setupProc();

		spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir);

		proc.stdout.write('{"type":"assistant","message":"Working on it"}\n');
		proc.stdout.write('{"type":"tool_use","name":"Read","input":{"file_path":"src/types.ts"}}\n');
		proc.stdout.write('{"type":"result","result":"Done","is_error":false}\n');
		await new Promise((r) => setTimeout(r, 50));

		proc.emit('close', 0);
		await new Promise((r) => setTimeout(r, 50));

		const readablePath = getReadableLogPath('pr-1', '10', tmpDir);
		expect(fs.existsSync(readablePath)).toBe(true);
		const content = fs.readFileSync(readablePath, 'utf-8');
		expect(content).toContain('Working on it');
		expect(content).toContain('[tool] Read src/types.ts');
		expect(content).toContain('[result] Done');
	});

	it('does not write non-readable types to readable log', async () => {
		const proc = setupProc();

		spawnWorker('10', 'pr-1', tmpDir, () => {}, undefined, tmpDir);

		proc.stdout.write('{"type":"system","subtype":"init","session_id":"s1"}\n');
		proc.stdout.write('{"type":"rate_limit_event"}\n');
		proc.stdout.write('{"type":"assistant","message":"hello"}\n');
		await new Promise((r) => setTimeout(r, 50));

		proc.emit('close', 0);
		await new Promise((r) => setTimeout(r, 50));

		const content = fs.readFileSync(getReadableLogPath('pr-1', '10', tmpDir), 'utf-8');
		expect(content).not.toContain('system');
		expect(content).not.toContain('rate_limit');
		expect(content).toContain('hello');
	});
});

describe('killWorker', () => {
	it('no-op if process already dead', async () => {
		const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			if (signal === 0) throw new Error('ESRCH');
			return true;
		});

		await killWorker(99999);

		// Only the liveness check should have been called
		expect(killSpy).toHaveBeenCalledWith(99999, 0);
		expect(killSpy).not.toHaveBeenCalledWith(99999, 'SIGTERM');
	});

	it('sends SIGTERM to alive process', async () => {
		let alive = true;
		const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			if (signal === 0 && !alive) throw new Error('ESRCH');
			if (signal === 'SIGTERM') {
				alive = false;
			}
			return true;
		});

		await killWorker(12345);

		expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
	});

	it('returns silently when process dies between liveness check and SIGTERM', async () => {
		let checkCount = 0;
		vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			if (signal === 0) {
				checkCount++;
				if (checkCount === 1) return true; // alive on first check
				throw new Error('ESRCH'); // dead on subsequent checks
			}
			if (signal === 'SIGTERM') {
				throw new Error('ESRCH'); // died between check and signal
			}
			return true;
		});

		await expect(killWorker(12345)).resolves.toBeUndefined();
	});

	it('escalates to SIGKILL when SIGTERM does not work', async () => {
		vi.useFakeTimers();
		const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			// Process stays alive through SIGTERM — only dies on SIGKILL
			if (signal === 'SIGKILL') return true;
			return true;
		});

		const promise = killWorker(12345);

		// Advance past the kill timeout
		await vi.advanceTimersByTimeAsync(6000);
		await promise;

		expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
		expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');

		vi.useRealTimers();
	});
});
