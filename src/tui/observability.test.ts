import { describe, expect, it } from 'vitest';
import type { GroupStatus } from '../types.js';
import {
	formatElapsed,
	formatStepLabel,
	isStale,
	parseToolUseActivity,
	trackStepStarts,
} from './observability.js';

describe('formatElapsed', () => {
	it('returns seconds only when under 1 minute', () => {
		const start = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:00:45.000Z';
		expect(formatElapsed(start, now)).toBe('45s');
	});

	it('returns minutes and seconds', () => {
		const start = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:02:34.000Z';
		expect(formatElapsed(start, now)).toBe('2m 34s');
	});

	it('returns hours, minutes, seconds for long durations', () => {
		const start = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T11:05:12.000Z';
		expect(formatElapsed(start, now)).toBe('1h 5m 12s');
	});

	it('returns 0s when start equals now', () => {
		const t = '2026-05-05T10:00:00.000Z';
		expect(formatElapsed(t, t)).toBe('0s');
	});

	it('clamps to 0s when start is in the future (clock skew)', () => {
		const start = '2026-05-05T10:01:00.000Z';
		const now = '2026-05-05T10:00:00.000Z';
		expect(formatElapsed(start, now)).toBe('0s');
	});

	it('floors partial seconds', () => {
		const start = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:00:02.999Z';
		expect(formatElapsed(start, now)).toBe('2s');
	});
});

const STALE_THRESHOLD = 90_000; // 90 seconds

describe('isStale', () => {
	it('returns false when activity is recent', () => {
		const lastActivity = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:01:00.000Z'; // 60s ago
		expect(isStale(lastActivity, now, STALE_THRESHOLD)).toBe(false);
	});

	it('returns true when no activity for threshold duration', () => {
		const lastActivity = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:01:30.000Z'; // exactly 90s
		expect(isStale(lastActivity, now, STALE_THRESHOLD)).toBe(true);
	});

	it('returns true when well past threshold', () => {
		const lastActivity = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:05:00.000Z'; // 5 minutes
		expect(isStale(lastActivity, now, STALE_THRESHOLD)).toBe(true);
	});

	it('returns false when just under threshold', () => {
		const lastActivity = '2026-05-05T10:00:00.000Z';
		const now = '2026-05-05T10:01:29.999Z'; // 89.999s
		expect(isStale(lastActivity, now, STALE_THRESHOLD)).toBe(false);
	});

	it('returns false when activity resumes (recent timestamp)', () => {
		const lastActivity = '2026-05-05T10:05:00.000Z'; // just updated
		const now = '2026-05-05T10:05:01.000Z';
		expect(isStale(lastActivity, now, STALE_THRESHOLD)).toBe(false);
	});
});

describe('formatStepLabel', () => {
	it('returns step name with elapsed time', () => {
		const result = formatStepLabel(
			'verifying',
			'2026-05-05T10:00:00.000Z',
			'2026-05-05T10:02:30.000Z',
			'2026-05-05T10:02:34.000Z',
			STALE_THRESHOLD,
		);
		expect(result).toBe('verifying (2m 34s)');
	});

	it('returns step name only when no start time', () => {
		const result = formatStepLabel(
			'coding',
			null,
			null,
			'2026-05-05T10:00:00.000Z',
			STALE_THRESHOLD,
		);
		expect(result).toBe('coding');
	});

	it('appends stale warning when no activity past threshold', () => {
		const result = formatStepLabel(
			'coding',
			'2026-05-05T10:00:00.000Z',
			'2026-05-05T10:00:10.000Z', // last activity 2m ago
			'2026-05-05T10:02:10.000Z',
			STALE_THRESHOLD,
		);
		expect(result).toBe('coding (2m 10s) \u26A0 no activity');
	});

	it('no stale warning when activity is recent', () => {
		const result = formatStepLabel(
			'coding',
			'2026-05-05T10:00:00.000Z',
			'2026-05-05T10:02:00.000Z', // activity 10s ago
			'2026-05-05T10:02:10.000Z',
			STALE_THRESHOLD,
		);
		expect(result).toBe('coding (2m 10s)');
	});

	it('uses stepStart for stale check when no lastActivity', () => {
		const result = formatStepLabel(
			'verifying',
			'2026-05-05T10:00:00.000Z',
			null, // no activity callback yet
			'2026-05-05T10:02:00.000Z',
			STALE_THRESHOLD,
		);
		// 2 minutes > 90s threshold, stale
		expect(result).toBe('verifying (2m 0s) \u26A0 no activity');
	});

	it('idle step returns just step name regardless', () => {
		const result = formatStepLabel(
			'idle',
			'2026-05-05T10:00:00.000Z',
			null,
			'2026-05-05T10:05:00.000Z',
			STALE_THRESHOLD,
		);
		expect(result).toBe('idle');
	});
});

function makeGroup(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-1',
		branch: 'feat/test',
		current_issue: 1,
		step: 'coding',
		step_result: '',
		issues_completed: [],
		issues_remaining: [1, 2],
		last_updated: '2026-05-05T10:00:00.000Z',
		...overrides,
	};
}

describe('trackStepStarts', () => {
	it('records start time for new groups', () => {
		const groups = [makeGroup({ pr_group: 'pr-1', step: 'coding' })];
		const result = trackStepStarts(new Map(), groups, '2026-05-05T10:00:00.000Z');

		expect(result.get('pr-1')).toBe('2026-05-05T10:00:00.000Z');
	});

	it('updates start time on step change', () => {
		const prev = new Map([['pr-1', '2026-05-05T09:00:00.000Z']]);
		const groups = [makeGroup({ pr_group: 'pr-1', step: 'verifying' })];
		// prev groups had step 'coding', now 'verifying' — but trackStepStarts needs prev step info
		// We need to pass prev groups too, or track step alongside timestamp
		const result = trackStepStarts(prev, groups, '2026-05-05T10:05:00.000Z', [
			makeGroup({ pr_group: 'pr-1', step: 'coding' }),
		]);

		expect(result.get('pr-1')).toBe('2026-05-05T10:05:00.000Z');
	});

	it('preserves start time when step unchanged', () => {
		const prev = new Map([['pr-1', '2026-05-05T09:00:00.000Z']]);
		const groups = [makeGroup({ pr_group: 'pr-1', step: 'coding' })];
		const result = trackStepStarts(prev, groups, '2026-05-05T10:05:00.000Z', [
			makeGroup({ pr_group: 'pr-1', step: 'coding' }),
		]);

		expect(result.get('pr-1')).toBe('2026-05-05T09:00:00.000Z');
	});

	it('removes entries for groups no longer present', () => {
		const prev = new Map([
			['pr-1', '2026-05-05T09:00:00.000Z'],
			['pr-2', '2026-05-05T09:00:00.000Z'],
		]);
		const groups = [makeGroup({ pr_group: 'pr-1', step: 'coding' })];
		const result = trackStepStarts(prev, groups, '2026-05-05T10:00:00.000Z', [
			makeGroup({ pr_group: 'pr-1', step: 'coding' }),
		]);

		expect(result.has('pr-2')).toBe(false);
		expect(result.size).toBe(1);
	});
});

describe('parseToolUseActivity', () => {
	it('extracts Read tool with file path', () => {
		const line = '{"type":"tool_use","name":"Read","input":{"file_path":"src/types.ts"}}';
		expect(parseToolUseActivity(line)).toBe('Reading src/types.ts');
	});

	it('extracts Edit tool with file path', () => {
		const line = '{"type":"tool_use","name":"Edit","input":{"file_path":"src/foo.ts"}}';
		expect(parseToolUseActivity(line)).toBe('Editing src/foo.ts');
	});

	it('extracts Write tool with file path', () => {
		const line = '{"type":"tool_use","name":"Write","input":{"file_path":"src/new.ts"}}';
		expect(parseToolUseActivity(line)).toBe('Writing src/new.ts');
	});

	it('extracts Bash tool with command', () => {
		const line = '{"type":"tool_use","name":"Bash","input":{"command":"pnpm run test"}}';
		expect(parseToolUseActivity(line)).toBe('Running pnpm run test');
	});

	it('truncates long Bash commands', () => {
		const longCmd = 'a'.repeat(100);
		const line = JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: longCmd } });
		const result = parseToolUseActivity(line);
		expect(result).not.toBeNull();
		expect(result?.length).toBeLessThanOrEqual(80);
	});

	it('extracts Grep tool with pattern', () => {
		const line = '{"type":"tool_use","name":"Grep","input":{"pattern":"TODO"}}';
		expect(parseToolUseActivity(line)).toBe('Grep TODO');
	});

	it('returns tool name for unknown input shape', () => {
		const line = '{"type":"tool_use","name":"WebSearch","input":{"query":"something"}}';
		expect(parseToolUseActivity(line)).toBe('WebSearch');
	});

	it('returns null for non-tool_use types', () => {
		expect(parseToolUseActivity('{"type":"assistant","message":"hello"}')).toBeNull();
		expect(parseToolUseActivity('{"type":"result","result":"done"}')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(parseToolUseActivity('not json')).toBeNull();
	});
});
