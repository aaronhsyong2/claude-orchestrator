import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRuntimeState } from './runtime.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runtime-'));
	const base = path.join(tmpDir, '.orchestrator');
	fs.mkdirSync(path.join(base, 'status'), { recursive: true });
	fs.mkdirSync(path.join(base, 'context'), { recursive: true });
	fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
	fs.writeFileSync(path.join(base, 'config.json'), '{}');
	fs.writeFileSync(path.join(base, 'status', 'test.json'), '{}');
	fs.writeFileSync(path.join(base, 'context', 'test.txt'), 'data');
	fs.writeFileSync(path.join(base, 'logs', 'test.log'), 'log');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('clearRuntimeState', () => {
	it('removes status, context, and logs directories', () => {
		clearRuntimeState(tmpDir);

		const base = path.join(tmpDir, '.orchestrator');
		expect(fs.existsSync(path.join(base, 'status'))).toBe(false);
		expect(fs.existsSync(path.join(base, 'context'))).toBe(false);
		expect(fs.existsSync(path.join(base, 'logs'))).toBe(false);
	});

	it('preserves config.json', () => {
		clearRuntimeState(tmpDir);

		const configPath = path.join(tmpDir, '.orchestrator', 'config.json');
		expect(fs.existsSync(configPath)).toBe(true);
	});

	it('no-ops when directories do not exist', () => {
		clearRuntimeState(tmpDir);
		expect(() => clearRuntimeState(tmpDir)).not.toThrow();
	});
});
