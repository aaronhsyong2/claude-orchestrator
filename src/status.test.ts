import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatStatus, getStatusDir, readStatusFiles } from './status.js';
import type { StatusEntry } from './types.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-status-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readStatusFiles', () => {
	it('returns empty array when status dir does not exist', () => {
		expect(readStatusFiles(tmpDir)).toEqual([]);
	});

	it('parses valid JSON files', () => {
		const statusDir = getStatusDir(tmpDir);
		fs.mkdirSync(statusDir, { recursive: true });

		const entry: StatusEntry = {
			slug: 'pr-auth',
			state: 'in_progress',
			issues_total: 5,
			issues_done: 2,
		};
		fs.writeFileSync(path.join(statusDir, 'pr-auth.json'), JSON.stringify(entry));

		const result = readStatusFiles(tmpDir);
		expect(result).toEqual([entry]);
	});

	it('skips invalid JSON files', () => {
		const statusDir = getStatusDir(tmpDir);
		fs.mkdirSync(statusDir, { recursive: true });

		fs.writeFileSync(path.join(statusDir, 'bad.json'), 'not json');
		fs.writeFileSync(
			path.join(statusDir, 'good.json'),
			JSON.stringify({ slug: 'ok', state: 'queued', issues_total: 3, issues_done: 0 }),
		);

		const result = readStatusFiles(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0]?.slug).toBe('ok');
	});

	it('skips JSON files with invalid state value', () => {
		const statusDir = getStatusDir(tmpDir);
		fs.mkdirSync(statusDir, { recursive: true });

		fs.writeFileSync(
			path.join(statusDir, 'bad-state.json'),
			JSON.stringify({ slug: 'bad', state: 'unknown_state', issues_total: 1, issues_done: 0 }),
		);

		expect(readStatusFiles(tmpDir)).toEqual([]);
	});

	it('skips JSON files with missing required fields', () => {
		const statusDir = getStatusDir(tmpDir);
		fs.mkdirSync(statusDir, { recursive: true });

		fs.writeFileSync(path.join(statusDir, 'malformed.json'), JSON.stringify({ slug: 'bad' }));
		fs.writeFileSync(
			path.join(statusDir, 'valid.json'),
			JSON.stringify({ slug: 'ok', state: 'queued', issues_total: 1, issues_done: 0 }),
		);

		const result = readStatusFiles(tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0]?.slug).toBe('ok');
	});

	it('ignores non-JSON files', () => {
		const statusDir = getStatusDir(tmpDir);
		fs.mkdirSync(statusDir, { recursive: true });

		fs.writeFileSync(path.join(statusDir, 'readme.txt'), 'hello');

		expect(readStatusFiles(tmpDir)).toEqual([]);
	});
});

describe('formatStatus', () => {
	it('returns "No active work." for empty entries', () => {
		expect(formatStatus([])).toBe('No active work.');
	});

	it('formats entries with header and rows', () => {
		const entries: readonly StatusEntry[] = [
			{ slug: 'pr-auth-module', state: 'in_progress', issues_total: 5, issues_done: 2 },
			{ slug: 'pr-api-endpoints', state: 'queued', issues_total: 3, issues_done: 0 },
		];

		const output = formatStatus(entries);
		expect(output).toContain('=== Orchestrator Status ===');
		expect(output).toContain('pr-auth-module');
		expect(output).toContain('in_progress');
		expect(output).toContain('2/5 issues done');
		expect(output).toContain('pr-api-endpoints');
		expect(output).toContain('queued');
		expect(output).toContain('0/3 issues done');
	});
});
