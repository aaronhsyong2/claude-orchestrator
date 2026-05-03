import { describe, expect, it } from 'vitest';
import type { GroupStatus } from '../types.js';
import { deriveActivity } from './use-status-poller.js';

function makeGroup(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-1',
		branch: 'feat/test',
		current_issue: 1,
		step: 'coding',
		step_result: '',
		issues_completed: [],
		issues_remaining: [1, 2],
		last_updated: '2026-05-03T00:00:00.000Z',
		...overrides,
	};
}

describe('deriveActivity', () => {
	it('emits appeared event for new groups', () => {
		const result = deriveActivity([], [makeGroup()], '14:00', 1);

		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.message).toBe('pr-1 appeared');
		expect(result.events[0]?.timestamp).toBe('14:00');
		expect(result.events[0]?.id).toBe(1);
		expect(result.nextId).toBe(2);
	});

	it('emits step change event with issue number', () => {
		const prev = [makeGroup({ step: 'cloning', current_issue: 5 })];
		const next = [makeGroup({ step: 'coding', current_issue: 5 })];
		const result = deriveActivity(prev, next, '14:01', 10);

		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.message).toBe('#5 coding');
		expect(result.events[0]?.id).toBe(10);
	});

	it('uses group slug when current_issue is null', () => {
		const prev = [makeGroup({ step: 'cloning', current_issue: null })];
		const next = [makeGroup({ step: 'coding', current_issue: null })];
		const result = deriveActivity(prev, next, '14:02', 1);

		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.message).toBe('pr-1 coding');
	});

	it('uses group slug when current_issue is 0', () => {
		const prev = [makeGroup({ step: 'cloning', current_issue: 0 as unknown as number })];
		const next = [makeGroup({ step: 'coding', current_issue: 0 as unknown as number })];
		const result = deriveActivity(prev, next, '14:03', 1);

		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.message).toBe('pr-1 coding');
	});

	it('returns empty when no changes', () => {
		const groups = [makeGroup()];
		const result = deriveActivity(groups, groups, '14:04', 1);

		expect(result.events).toHaveLength(0);
		expect(result.nextId).toBe(1);
	});

	it('handles multiple groups with mixed changes', () => {
		const prev = [
			makeGroup({ pr_group: 'pr-1', step: 'coding' }),
			makeGroup({ pr_group: 'pr-2', step: 'verifying' }),
		];
		const next = [
			makeGroup({ pr_group: 'pr-1', step: 'coding' }),
			makeGroup({ pr_group: 'pr-2', step: 'reviewing' }),
			makeGroup({ pr_group: 'pr-3', step: 'cloning' }),
		];
		const result = deriveActivity(prev, next, '14:05', 1);

		expect(result.events).toHaveLength(2);
		expect(result.events[0]?.message).toBe('#1 reviewing');
		expect(result.events[1]?.message).toBe('pr-3 appeared');
	});

	it('increments ids without mutating startId', () => {
		const next = [makeGroup({ pr_group: 'pr-1' }), makeGroup({ pr_group: 'pr-2' })];
		const result = deriveActivity([], next, '14:06', 100);

		expect(result.events).toHaveLength(2);
		expect(result.events[0]?.id).toBe(100);
		expect(result.events[1]?.id).toBe(101);
		expect(result.nextId).toBe(102);
	});
});
