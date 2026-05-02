import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NdjsonMessage, WorkerEventType } from './types.js';
import {
	buildPrompt,
	getLogDir,
	getLogPath,
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

describe('spawnWorker', () => {
	type EventEntry = {
		event: WorkerEventType;
		data: NdjsonMessage | number | Error;
	};

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
		const cb = (e: WorkerEventType, d: NdjsonMessage | number | Error) =>
			events.push({ event: e, data: d });
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
			['-p', '--output-format', 'stream-json', '/pick-up #10'],
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
		expect(events[0]).toEqual({ event: 'spawned', data: 0 });
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
				'--output-format',
				'stream-json',
				'/pick-up #10\n\nContext from previous attempt:\nPrevious context here',
			],
			expect.anything(),
		);
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
