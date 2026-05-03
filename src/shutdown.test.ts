import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearShutdownFile,
	createWorkerRegistry,
	forceKillAll,
	getShutdownPath,
	readShutdownFile,
	writeShutdownFile,
} from './shutdown.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-shutdown-'));
	fs.mkdirSync(path.join(tmpDir, '.orchestrator'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getShutdownPath', () => {
	it('returns path ending in .orchestrator/shutdown', () => {
		const result = getShutdownPath(tmpDir);
		expect(result).toMatch(/\.orchestrator\/shutdown$/);
	});

	it('uses baseDir when provided', () => {
		const result = getShutdownPath('/some/base');
		expect(result).toBe(path.resolve('/some/base', '.orchestrator/shutdown'));
	});
});

describe('writeShutdownFile', () => {
	it('creates file with valid JSON containing mode and requested_at', () => {
		writeShutdownFile('graceful', tmpDir);
		const content = fs.readFileSync(getShutdownPath(tmpDir), 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.mode).toBe('graceful');
		expect(parsed.requested_at).toBeDefined();
	});

	it('creates directory if missing', () => {
		const nested = path.join(tmpDir, 'deep', 'nested');
		writeShutdownFile('graceful', nested);
		expect(fs.existsSync(getShutdownPath(nested))).toBe(true);
	});

	it('overwrites existing file (graceful -> force upgrade)', () => {
		writeShutdownFile('graceful', tmpDir);
		writeShutdownFile('force', tmpDir);
		const content = fs.readFileSync(getShutdownPath(tmpDir), 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.mode).toBe('force');
	});

	it('mode graceful writes correct mode', () => {
		writeShutdownFile('graceful', tmpDir);
		const parsed = JSON.parse(fs.readFileSync(getShutdownPath(tmpDir), 'utf-8'));
		expect(parsed.mode).toBe('graceful');
	});

	it('mode force writes correct mode', () => {
		writeShutdownFile('force', tmpDir);
		const parsed = JSON.parse(fs.readFileSync(getShutdownPath(tmpDir), 'utf-8'));
		expect(parsed.mode).toBe('force');
	});
});

describe('readShutdownFile', () => {
	it('returns null when file missing', () => {
		expect(readShutdownFile(tmpDir)).toBeNull();
	});

	it('returns ShutdownSignal for valid file', () => {
		writeShutdownFile('graceful', tmpDir);
		const result = readShutdownFile(tmpDir);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('graceful');
		expect(result?.requested_at).toBeDefined();
	});

	it('returns null for malformed JSON', () => {
		fs.writeFileSync(getShutdownPath(tmpDir), 'not-json{{{');
		expect(readShutdownFile(tmpDir)).toBeNull();
	});

	it('returns null for invalid mode value', () => {
		fs.writeFileSync(getShutdownPath(tmpDir), JSON.stringify({ mode: 'unknown' }));
		expect(readShutdownFile(tmpDir)).toBeNull();
	});
});

describe('clearShutdownFile', () => {
	it('removes existing file', () => {
		writeShutdownFile('graceful', tmpDir);
		expect(fs.existsSync(getShutdownPath(tmpDir))).toBe(true);
		clearShutdownFile(tmpDir);
		expect(fs.existsSync(getShutdownPath(tmpDir))).toBe(false);
	});

	it('no-ops when file missing (no throw)', () => {
		expect(() => clearShutdownFile(tmpDir)).not.toThrow();
	});
});

describe('createWorkerRegistry', () => {
	it('register adds PID, getActivePids returns it', () => {
		const registry = createWorkerRegistry();
		registry.register(123);
		expect(registry.getActivePids()).toEqual([123]);
	});

	it('deregister removes PID', () => {
		const registry = createWorkerRegistry();
		registry.register(123);
		registry.deregister(123);
		expect(registry.getActivePids()).toEqual([]);
	});

	it('deregister no-ops for unknown PID', () => {
		const registry = createWorkerRegistry();
		registry.register(123);
		registry.deregister(999);
		expect(registry.getActivePids()).toEqual([123]);
	});

	it('getActivePids returns empty array initially', () => {
		const registry = createWorkerRegistry();
		expect(registry.getActivePids()).toEqual([]);
	});

	it('multiple register/deregister cycles work correctly', () => {
		const registry = createWorkerRegistry();
		registry.register(1);
		registry.register(2);
		registry.register(3);
		registry.deregister(2);
		registry.register(4);
		registry.deregister(1);
		const pids = registry.getActivePids();
		expect(pids).toContain(3);
		expect(pids).toContain(4);
		expect(pids).not.toContain(1);
		expect(pids).not.toContain(2);
	});
});

describe('forceKillAll', () => {
	it('calls killWorker for each active PID', async () => {
		const mockKill = vi.fn().mockResolvedValue(undefined);
		const registry = createWorkerRegistry();
		registry.register(100);
		registry.register(200);

		await forceKillAll(registry, mockKill);

		expect(mockKill).toHaveBeenCalledTimes(2);
		expect(mockKill).toHaveBeenCalledWith(100);
		expect(mockKill).toHaveBeenCalledWith(200);
	});

	it('handles empty registry (no calls)', async () => {
		const mockKill = vi.fn().mockResolvedValue(undefined);
		const registry = createWorkerRegistry();

		await forceKillAll(registry, mockKill);

		expect(mockKill).not.toHaveBeenCalled();
	});

	it('handles killWorker rejection gracefully (Promise.allSettled)', async () => {
		const mockKill = vi.fn().mockRejectedValue(new Error('ESRCH'));
		const registry = createWorkerRegistry();
		registry.register(100);
		registry.register(200);

		// Should not throw despite rejections
		await expect(forceKillAll(registry, mockKill)).resolves.not.toThrow();
	});
});
