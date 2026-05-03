import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMergedPRs, hasExistingState, resetToCheckpoint } from './resume.js';
import type { ExecResult, GroupStatus } from './types.js';

let tmpDir: string;

const NOW = '2026-05-02T12:00:00.000Z';
const now = () => NOW;

function makeStatus(overrides: Partial<GroupStatus> = {}): GroupStatus {
	return {
		pr_group: 'test-group',
		branch: 'feat/test',
		current_issue: null,
		step: 'idle',
		step_result: '',
		issues_completed: [],
		issues_remaining: [1, 2],
		last_updated: '2026-05-01T00:00:00.000Z',
		...overrides,
	};
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hasExistingState', () => {
	it('returns false when status dir missing', () => {
		expect(hasExistingState(tmpDir)).toBe(false);
	});

	it('returns false when status dir empty', () => {
		fs.mkdirSync(path.join(tmpDir, '.orchestrator/status'), { recursive: true });
		expect(hasExistingState(tmpDir)).toBe(false);
	});

	it('returns true when status dir has .json files', () => {
		const statusDir = path.join(tmpDir, '.orchestrator/status');
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(path.join(statusDir, 'group-a.json'), '{}');
		expect(hasExistingState(tmpDir)).toBe(true);
	});

	it('returns false when status dir has only non-json files', () => {
		const statusDir = path.join(tmpDir, '.orchestrator/status');
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(path.join(statusDir, 'readme.txt'), 'hello');
		expect(hasExistingState(tmpDir)).toBe(false);
	});
});

describe('resetToCheckpoint', () => {
	const emptyMerged: ReadonlySet<string> = new Set();

	it('idle + pass + no remaining -> resets to idle with empty step_result', () => {
		const status = makeStatus({
			step: 'idle',
			step_result: 'pass',
			issues_remaining: [],
		});
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.current_issue).toBeNull();
		expect(result.last_updated).toBe(NOW);
	});

	it('reviewing -> resets to idle', () => {
		const status = makeStatus({ step: 'reviewing', step_result: 'cycle 1' });
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.current_issue).toBeNull();
	});

	it('pr-creating -> resets to idle', () => {
		const status = makeStatus({ step: 'pr-creating' });
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
	});

	it('pr-reviewing -> resets to idle', () => {
		const status = makeStatus({ step: 'pr-reviewing' });
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
	});

	it('awaiting-merge + branch merged -> marks fully done', () => {
		const status = makeStatus({
			step: 'awaiting-merge',
			branch: 'feat/merged-branch',
			issues_remaining: [1, 2],
		});
		const mergedSet: ReadonlySet<string> = new Set(['feat/merged-branch']);
		const result = resetToCheckpoint(status, mergedSet, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('pass');
		expect(result.current_issue).toBeNull();
		expect(result.issues_remaining).toEqual([]);
	});

	it('awaiting-merge + branch NOT merged -> returns unchanged', () => {
		const status = makeStatus({
			step: 'awaiting-merge',
			branch: 'feat/pending-branch',
		});
		const result = resetToCheckpoint(status, emptyMerged, now);
		// Should return exact same reference (unchanged)
		expect(result).toBe(status);
	});

	it('coding -> resets to idle (current_issue preserved for retry)', () => {
		const status = makeStatus({
			step: 'coding',
			current_issue: 42,
		});
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.current_issue).toBe(42);
	});

	it('cloning -> resets to idle (current_issue preserved)', () => {
		const status = makeStatus({ step: 'cloning', current_issue: 10 });
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.current_issue).toBe(10);
	});

	it('verifying -> resets to idle (current_issue preserved)', () => {
		const status = makeStatus({ step: 'verifying', current_issue: 10 });
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.current_issue).toBe(10);
	});

	it('idle + interrupted -> resets step_result to empty', () => {
		const status = makeStatus({
			step: 'idle',
			step_result: 'interrupted',
		});
		const result = resetToCheckpoint(status, emptyMerged, now);
		expect(result.step).toBe('idle');
		expect(result.step_result).toBe('');
		expect(result.last_updated).toBe(NOW);
	});

	it('unknown/default idle state -> returns unchanged', () => {
		const status = makeStatus({
			step: 'idle',
			step_result: 'some-other-value',
			issues_remaining: [1],
		});
		const result = resetToCheckpoint(status, emptyMerged, now);
		// Default branch: return unchanged
		expect(result).toBe(status);
	});
});

describe('detectMergedPRs', () => {
	it('returns merged branches when gh reports merged PRs', async () => {
		const mockExec = vi
			.fn<(cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>>()
			.mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify([{ number: 42, state: 'MERGED' }]),
				stderr: '',
			});

		const statuses: readonly GroupStatus[] = [
			makeStatus({ step: 'awaiting-merge', branch: 'feat/merged-one' }),
		];

		const result = await detectMergedPRs(statuses, mockExec);
		expect(result).toEqual(['feat/merged-one']);
	});

	it('returns empty array for no awaiting-merge statuses', async () => {
		const mockExec = vi
			.fn<(cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>>()
			.mockResolvedValue({
				exitCode: 0,
				stdout: '[]',
				stderr: '',
			});

		const statuses: readonly GroupStatus[] = [
			makeStatus({ step: 'coding', branch: 'feat/coding-branch' }),
			makeStatus({ step: 'idle', branch: 'feat/idle-branch' }),
		];

		const result = await detectMergedPRs(statuses, mockExec);
		expect(result).toEqual([]);
		expect(mockExec).not.toHaveBeenCalled();
	});

	it('handles gh command failure gracefully (returns empty, logs warning)', async () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const mockExec = vi
			.fn<(cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>>()
			.mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: 'gh: not authenticated',
			});

		const statuses: readonly GroupStatus[] = [
			makeStatus({ step: 'awaiting-merge', branch: 'feat/fail-branch' }),
		];

		const result = await detectMergedPRs(statuses, mockExec);
		expect(result).toEqual([]);
		expect(stderrSpy).toHaveBeenCalled();
		stderrSpy.mockRestore();
	});

	it('skips non-awaiting-merge statuses', async () => {
		const mockExec = vi
			.fn<(cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>>()
			.mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify([{ number: 1, state: 'MERGED' }]),
				stderr: '',
			});

		const statuses: readonly GroupStatus[] = [
			makeStatus({ step: 'idle', branch: 'feat/idle' }),
			makeStatus({ step: 'awaiting-merge', branch: 'feat/waiting' }),
			makeStatus({ step: 'coding', branch: 'feat/coding' }),
		];

		const result = await detectMergedPRs(statuses, mockExec);
		// Only the awaiting-merge status should trigger an exec call
		expect(mockExec).toHaveBeenCalledTimes(1);
		expect(result).toEqual(['feat/waiting']);
	});
});
