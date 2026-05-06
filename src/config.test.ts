import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	configExists,
	DEFAULT_CONFIG,
	getConfigPath,
	loadConfig,
	validateConfig,
	writeDefaultConfig,
} from './config.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DEFAULT_CONFIG', () => {
	it('matches PRD v2 shape', () => {
		expect(DEFAULT_CONFIG.base_branch).toBe('main');
		expect(DEFAULT_CONFIG.max_concurrent_agents).toBe(3);
		expect(DEFAULT_CONFIG.max_retries_on_fail).toBe(2);
		expect(DEFAULT_CONFIG.max_review_cycles).toBe(3);
		expect(DEFAULT_CONFIG.verify).toHaveLength(5);
		expect(DEFAULT_CONFIG.verify[0]).toEqual({ name: 'lint', command: 'pnpm run check' });
		expect(DEFAULT_CONFIG.rule_files).toContain('CLAUDE.md');
		expect(DEFAULT_CONFIG.issue_source).toEqual({ type: 'github', repo: 'org/repo-name' });
		expect(DEFAULT_CONFIG.notifications).toEqual({ system: true });
	});
});

describe('getConfigPath', () => {
	it('returns path under .orchestrator/', () => {
		const result = getConfigPath(tmpDir);
		expect(result).toBe(path.resolve(tmpDir, '.orchestrator/config.json'));
	});
});

describe('configExists', () => {
	it('returns false when config does not exist', () => {
		expect(configExists(tmpDir)).toBe(false);
	});

	it('returns true when config exists', () => {
		writeDefaultConfig(tmpDir);
		expect(configExists(tmpDir)).toBe(true);
	});
});

describe('writeDefaultConfig', () => {
	it('creates config file with correct content', () => {
		const result = writeDefaultConfig(tmpDir);
		expect(result).toBe(true);

		const configPath = getConfigPath(tmpDir);
		expect(fs.existsSync(configPath)).toBe(true);

		const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		expect(content).toEqual(DEFAULT_CONFIG);
	});

	it('returns false when config exists and force is false', () => {
		writeDefaultConfig(tmpDir);
		const result = writeDefaultConfig(tmpDir, false);
		expect(result).toBe(false);
	});

	it('overwrites when force is true', () => {
		writeDefaultConfig(tmpDir);
		const result = writeDefaultConfig(tmpDir, true);
		expect(result).toBe(true);

		const content = JSON.parse(fs.readFileSync(getConfigPath(tmpDir), 'utf-8'));
		expect(content).toEqual(DEFAULT_CONFIG);
	});

	it('creates .orchestrator/ directory if missing', () => {
		const orchDir = path.join(tmpDir, '.orchestrator');
		expect(fs.existsSync(orchDir)).toBe(false);

		writeDefaultConfig(tmpDir);
		expect(fs.existsSync(orchDir)).toBe(true);
	});
});

describe('validateConfig', () => {
	it('returns true for valid config', () => {
		expect(validateConfig(DEFAULT_CONFIG)).toBe(true);
	});

	it('returns false for null', () => {
		expect(validateConfig(null)).toBe(false);
	});

	it('returns false for missing fields', () => {
		expect(validateConfig({ base_branch: 'main' })).toBe(false);
	});

	it('returns false for wrong field types', () => {
		expect(validateConfig({ ...DEFAULT_CONFIG, max_concurrent_agents: 'three' })).toBe(false);
	});

	it('accepts config with optional routing field', () => {
		const withRouting = {
			...DEFAULT_CONFIG,
			routing: { 'bug+ready-for-agent': '/diagnose' },
		};
		expect(validateConfig(withRouting)).toBe(true);
	});

	it('accepts config without routing field', () => {
		const { routing: _, ...withoutRouting } = { ...DEFAULT_CONFIG, routing: undefined };
		expect(validateConfig(withoutRouting)).toBe(true);
	});

	it('rejects config with invalid routing shape', () => {
		expect(validateConfig({ ...DEFAULT_CONFIG, routing: 42 })).toBe(false);
		expect(validateConfig({ ...DEFAULT_CONFIG, routing: ['/tdd'] })).toBe(false);
		expect(validateConfig({ ...DEFAULT_CONFIG, routing: null })).toBe(false);
	});

	it('rejects config with non-string routing values', () => {
		expect(validateConfig({ ...DEFAULT_CONFIG, routing: { key: 42 } })).toBe(false);
		expect(validateConfig({ ...DEFAULT_CONFIG, routing: { key: null } })).toBe(false);
	});
});

describe('loadConfig', () => {
	it('reads and parses config file', () => {
		writeDefaultConfig(tmpDir);
		const config = loadConfig(tmpDir);
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	it('throws with message when config does not exist', () => {
		expect(() => loadConfig(tmpDir)).toThrow(/Failed to read config/);
	});

	it('throws on invalid JSON', () => {
		const configPath = getConfigPath(tmpDir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, 'not json');
		expect(() => loadConfig(tmpDir)).toThrow(/Invalid JSON/);
	});

	it('throws on invalid config shape', () => {
		const configPath = getConfigPath(tmpDir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ bad: true }));
		expect(() => loadConfig(tmpDir)).toThrow(/Invalid config shape/);
	});
});
