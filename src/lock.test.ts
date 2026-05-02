import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	acquireLock,
	getLockPath,
	isLockStale,
	isProcessAlive,
	readLock,
	releaseLock,
} from './lock.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-'));
	fs.mkdirSync(path.join(tmpDir, '.orchestrator'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isProcessAlive', () => {
	it('returns true for current process', () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it('returns false for dead PID', () => {
		// Spawn a short-lived process and use its PID after it exits
		const output = execSync('echo $$', { shell: '/bin/sh', encoding: 'utf-8' });
		const deadPid = Number.parseInt(output.trim(), 10);
		expect(isProcessAlive(deadPid)).toBe(false);
	});
});

describe('readLock', () => {
	it('returns null when no lock file', () => {
		expect(readLock(tmpDir)).toBeNull();
	});

	it('returns PID from lock file', () => {
		fs.writeFileSync(getLockPath(tmpDir), '12345\n');
		expect(readLock(tmpDir)).toBe(12345);
	});

	it('returns null for invalid content', () => {
		fs.writeFileSync(getLockPath(tmpDir), 'garbage\n');
		expect(readLock(tmpDir)).toBeNull();
	});
});

describe('isLockStale', () => {
	it('returns false when no lock file', () => {
		expect(isLockStale(tmpDir)).toBe(false);
	});

	it('returns false when lock PID is alive', () => {
		fs.writeFileSync(getLockPath(tmpDir), `${process.pid}\n`);
		expect(isLockStale(tmpDir)).toBe(false);
	});

	it('returns true when lock PID is dead', () => {
		fs.writeFileSync(getLockPath(tmpDir), '999999\n');
		expect(isLockStale(tmpDir)).toBe(true);
	});
});

describe('acquireLock', () => {
	it('creates lock file with current PID', () => {
		acquireLock(tmpDir);
		const pid = readLock(tmpDir);
		expect(pid).toBe(process.pid);
	});

	it('throws when active lock exists', () => {
		fs.writeFileSync(getLockPath(tmpDir), `${process.pid}\n`);
		expect(() => acquireLock(tmpDir)).toThrow(/Another orchestrator is running/);
	});

	it('cleans stale lock and acquires', () => {
		fs.writeFileSync(getLockPath(tmpDir), '999999\n');
		acquireLock(tmpDir);
		expect(readLock(tmpDir)).toBe(process.pid);
	});
});

describe('releaseLock', () => {
	it('removes lock file owned by current process', () => {
		acquireLock(tmpDir);
		releaseLock(tmpDir);
		expect(readLock(tmpDir)).toBeNull();
	});

	it('no-ops when no lock file', () => {
		expect(() => releaseLock(tmpDir)).not.toThrow();
	});

	it('does not remove lock owned by another PID', () => {
		fs.writeFileSync(getLockPath(tmpDir), '12345\n');
		releaseLock(tmpDir);
		expect(readLock(tmpDir)).toBe(12345);
	});
});
