import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	deleteContext,
	getContextDir,
	getGroupStatusPath,
	readContext,
	readGroupStatus,
	reconcile,
	writeContext,
	writeGroupStatus,
} from './status-manager.js';
import type { GitBranchState, GroupStatus } from './types.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sm-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStatus(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-1',
		branch: 'feat/pr-1',
		current_issue: 10,
		step: 'coding',
		step_result: '',
		issues_completed: [9],
		issues_remaining: [10, 11],
		blocked: false,
		needs_input: false,
		last_updated: '2026-05-02T12:00:00.000Z',
		...overrides,
	};
}

const FIXED_TIME = '2026-05-02T16:00:00.000Z';
const fixedClock = () => FIXED_TIME;

describe('context issue validation', () => {
	it('rejects path traversal in issue param', () => {
		expect(() => writeContext('pr-1', '../../../etc', 'x', tmpDir)).toThrow(
			/Invalid issue identifier/,
		);
	});

	it('rejects empty issue param', () => {
		expect(() => readContext('pr-1', '', tmpDir)).toThrow(/Invalid issue identifier/);
	});

	it('accepts valid issue identifiers', () => {
		writeContext('pr-1', 'issue-10', 'content', tmpDir);
		expect(readContext('pr-1', 'issue-10', tmpDir)).toBe('content');
	});
});

describe('slug validation', () => {
	it('rejects slugs with path traversal', () => {
		expect(() => readGroupStatus('../../etc/passwd', tmpDir)).toThrow(/Invalid slug/);
	});

	it('rejects slugs with slashes', () => {
		expect(() => writeGroupStatus('foo/bar', makeStatus(), tmpDir)).toThrow(/Invalid slug/);
	});

	it('rejects empty slugs', () => {
		expect(() => readContext('', 'issue-1', tmpDir)).toThrow(/Invalid slug/);
	});

	it('rejects slugs with uppercase', () => {
		expect(() => writeContext('PR-1', 'issue', 'content', tmpDir)).toThrow(/Invalid slug/);
	});

	it('accepts valid slugs', () => {
		expect(() => readGroupStatus('pr-1', tmpDir)).not.toThrow();
		expect(() => readGroupStatus('my-feature-123', tmpDir)).not.toThrow();
	});
});

describe('readGroupStatus', () => {
	it('returns null for missing file', () => {
		expect(readGroupStatus('nonexistent', tmpDir)).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		const statusDir = path.dirname(getGroupStatusPath('bad', tmpDir));
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(getGroupStatusPath('bad', tmpDir), 'not json');

		expect(readGroupStatus('bad', tmpDir)).toBeNull();
	});

	it('returns null for invalid shape', () => {
		const statusDir = path.dirname(getGroupStatusPath('bad', tmpDir));
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(getGroupStatusPath('bad', tmpDir), JSON.stringify({ pr_group: 'x' }));

		expect(readGroupStatus('bad', tmpDir)).toBeNull();
	});

	it('returns validated GroupStatus for valid file', () => {
		const data = makeStatus();
		const statusDir = path.dirname(getGroupStatusPath('pr-1', tmpDir));
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(getGroupStatusPath('pr-1', tmpDir), JSON.stringify(data));

		const result = readGroupStatus('pr-1', tmpDir);
		expect(result).toEqual(data);
	});

	it('returns null for invalid step value', () => {
		const statusDir = path.dirname(getGroupStatusPath('bad-step', tmpDir));
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(
			getGroupStatusPath('bad-step', tmpDir),
			JSON.stringify({ ...makeStatus(), step: 'exploding' }),
		);

		expect(readGroupStatus('bad-step', tmpDir)).toBeNull();
	});
});

describe('writeGroupStatus', () => {
	it('creates directories on first write', () => {
		const data = makeStatus();
		writeGroupStatus('pr-1', data, tmpDir);

		const filePath = getGroupStatusPath('pr-1', tmpDir);
		expect(fs.existsSync(filePath)).toBe(true);
	});

	it('writes valid JSON that round-trips', () => {
		const data = makeStatus();
		writeGroupStatus('pr-1', data, tmpDir);

		const result = readGroupStatus('pr-1', tmpDir);
		expect(result).toEqual(data);
	});

	it('leaves no .tmp file after write', () => {
		writeGroupStatus('pr-1', makeStatus(), tmpDir);

		const statusDir = path.dirname(getGroupStatusPath('pr-1', tmpDir));
		const files = fs.readdirSync(statusDir);
		expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});

	it('does not mutate input data', () => {
		const data = makeStatus();
		const original = JSON.stringify(data);
		writeGroupStatus('pr-1', data, tmpDir);
		expect(JSON.stringify(data)).toBe(original);
	});

	it('overwrites existing status', () => {
		writeGroupStatus('pr-1', makeStatus({ step: 'coding' }), tmpDir);
		writeGroupStatus('pr-1', makeStatus({ step: 'verifying' }), tmpDir);

		const result = readGroupStatus('pr-1', tmpDir);
		expect(result?.step).toBe('verifying');
	});
});

describe('writeContext', () => {
	it('creates file and directories', () => {
		writeContext('pr-1', 'issue-10', '# Approach\nDoing stuff.', tmpDir);

		const filePath = path.join(getContextDir('pr-1', tmpDir), 'issue-10.md');
		expect(fs.existsSync(filePath)).toBe(true);
	});

	it('writes correct content', () => {
		const content = '# Context\nApproach taken: X\nFiles: a.ts, b.ts';
		writeContext('pr-1', 'issue-10', content, tmpDir);

		const result = readContext('pr-1', 'issue-10', tmpDir);
		expect(result).toBe(content);
	});

	it('overwrites existing content', () => {
		writeContext('pr-1', 'issue-10', 'first attempt', tmpDir);
		writeContext('pr-1', 'issue-10', 'second attempt', tmpDir);

		expect(readContext('pr-1', 'issue-10', tmpDir)).toBe('second attempt');
	});
});

describe('readContext', () => {
	it('returns content for existing file', () => {
		writeContext('pr-1', 'issue-10', 'hello', tmpDir);
		expect(readContext('pr-1', 'issue-10', tmpDir)).toBe('hello');
	});

	it('returns null for missing file', () => {
		expect(readContext('pr-1', 'nonexistent', tmpDir)).toBeNull();
	});

	it('returns null for missing directory', () => {
		expect(readContext('nonexistent-group', 'issue-1', tmpDir)).toBeNull();
	});
});

describe('deleteContext', () => {
	it('removes existing file', () => {
		writeContext('pr-1', 'issue-10', 'content', tmpDir);
		deleteContext('pr-1', 'issue-10', tmpDir);

		expect(readContext('pr-1', 'issue-10', tmpDir)).toBeNull();
	});

	it('no-op for missing file', () => {
		expect(() => deleteContext('pr-1', 'nonexistent', tmpDir)).not.toThrow();
	});

	it('no-op for missing directory', () => {
		expect(() => deleteContext('nonexistent', 'issue-1', tmpDir)).not.toThrow();
	});
});

describe('reconcile', () => {
	it('returns no corrections when branch state matches', () => {
		writeGroupStatus('pr-1', makeStatus({ branch: 'feat/pr-1', step: 'coding' }), tmpDir);

		const gitState: GitBranchState = {
			branches: ['feat/pr-1'],
			branchHasCommits: new Map([['feat/pr-1', true]]),
		};

		const corrections = reconcile(gitState, tmpDir);
		expect(corrections).toEqual([]);
	});

	it('corrects status when branch is missing', () => {
		writeGroupStatus(
			'pr-1',
			makeStatus({ branch: 'feat/pr-1', step: 'coding', current_issue: 10 }),
			tmpDir,
		);

		const gitState: GitBranchState = {
			branches: [],
			branchHasCommits: new Map(),
		};

		const corrections = reconcile(gitState, tmpDir, fixedClock);
		expect(corrections).toHaveLength(1);
		expect(corrections[0]?.reason).toContain('no longer exists');

		const updated = readGroupStatus('pr-1', tmpDir);
		expect(updated?.step).toBe('idle');
		expect(updated?.current_issue).toBeNull();
		expect(updated?.last_updated).toBe(FIXED_TIME);
	});

	it('corrects status when branch has no commits', () => {
		writeGroupStatus('pr-1', makeStatus({ branch: 'feat/pr-1', step: 'verifying' }), tmpDir);

		const gitState: GitBranchState = {
			branches: ['feat/pr-1'],
			branchHasCommits: new Map([['feat/pr-1', false]]),
		};

		const corrections = reconcile(gitState, tmpDir, fixedClock);
		expect(corrections).toHaveLength(1);
		expect(corrections[0]?.reason).toContain('no commits');

		const updated = readGroupStatus('pr-1', tmpDir);
		expect(updated?.step).toBe('idle');
		expect(updated?.last_updated).toBe(FIXED_TIME);
	});

	it('does not correct already-idle status for no-commit branch', () => {
		writeGroupStatus(
			'pr-1',
			makeStatus({ branch: 'feat/pr-1', step: 'idle', current_issue: null }),
			tmpDir,
		);

		const gitState: GitBranchState = {
			branches: ['feat/pr-1'],
			branchHasCommits: new Map([['feat/pr-1', false]]),
		};

		const corrections = reconcile(gitState, tmpDir);
		expect(corrections).toEqual([]);
	});

	it('skips invalid status files', () => {
		const statusDir = path.resolve(tmpDir, '.orchestrator/status');
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(path.join(statusDir, 'bad.json'), 'not json');

		const gitState: GitBranchState = {
			branches: [],
			branchHasCommits: new Map(),
		};

		const corrections = reconcile(gitState, tmpDir);
		expect(corrections).toEqual([]);
	});

	it('returns empty for missing status directory', () => {
		const gitState: GitBranchState = {
			branches: [],
			branchHasCommits: new Map(),
		};

		expect(reconcile(gitState, tmpDir)).toEqual([]);
	});

	it('returns empty for empty status directory', () => {
		const statusDir = path.resolve(tmpDir, '.orchestrator/status');
		fs.mkdirSync(statusDir, { recursive: true });

		const gitState: GitBranchState = {
			branches: [],
			branchHasCommits: new Map(),
		};

		expect(reconcile(gitState, tmpDir)).toEqual([]);
	});

	it('handles multiple status files with mixed corrections', () => {
		writeGroupStatus(
			'pr-1',
			makeStatus({ pr_group: 'pr-1', branch: 'feat/pr-1', step: 'coding' }),
			tmpDir,
		);
		writeGroupStatus(
			'pr-2',
			makeStatus({ pr_group: 'pr-2', branch: 'feat/pr-2', step: 'reviewing' }),
			tmpDir,
		);

		const gitState: GitBranchState = {
			branches: ['feat/pr-1'],
			branchHasCommits: new Map([['feat/pr-1', true]]),
		};

		const corrections = reconcile(gitState, tmpDir);
		expect(corrections).toHaveLength(1);
		expect(corrections[0]?.slug).toBe('pr-2');
	});
});
