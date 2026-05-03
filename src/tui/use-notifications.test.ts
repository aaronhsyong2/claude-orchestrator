import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GroupStatus, NotificationConfig } from '../types.js';
import { detectTransition } from './use-notifications.js';

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

describe('detectTransition', () => {
	it('returns warning for needs-input', () => {
		const result = detectTransition(makeGroup({ step_result: 'needs-input' }));
		expect(result).toEqual({ message: 'pr-1: needs input' });
	});

	it('returns error for worktree error', () => {
		const result = detectTransition(makeGroup({ step_result: 'worktree error: branch not found' }));
		expect(result).toEqual({ message: 'pr-1: worktree error: branch not found' });
	});

	it('returns error for worker error', () => {
		const result = detectTransition(makeGroup({ step_result: 'worker error: ENOENT' }));
		expect(result).toEqual({ message: 'pr-1: worker error: ENOENT' });
	});

	it('returns info for ready for self-review', () => {
		const result = detectTransition(
			makeGroup({ step: 'reviewing', step_result: 'ready for self-review' }),
		);
		expect(result).toEqual({ message: 'pr-1: review cycle complete' });
	});

	it('returns null for ready for self-review when not reviewing', () => {
		const result = detectTransition(
			makeGroup({ step: 'coding', step_result: 'ready for self-review' }),
		);
		expect(result).toBeNull();
	});

	it('returns null for empty step_result', () => {
		const result = detectTransition(makeGroup({ step_result: '' }));
		expect(result).toBeNull();
	});

	it('returns null for pass', () => {
		const result = detectTransition(makeGroup({ step_result: 'pass' }));
		expect(result).toBeNull();
	});

	it('returns null for blocked', () => {
		const result = detectTransition(makeGroup({ step_result: 'blocked' }));
		expect(result).toBeNull();
	});

	it('returns null for generic step_result', () => {
		const result = detectTransition(makeGroup({ step_result: 'failed: lint' }));
		expect(result).toBeNull();
	});
});

// Mock notify to test useNotifications hook behavior
const mockNotify = vi.fn((_message: string, _config: NotificationConfig) => Promise.resolve());
vi.mock('./notification-service.js', () => ({
	notify: (message: string, config: NotificationConfig) => mockNotify(message, config),
}));

// Import after mock
const { useNotifications } = await import('./use-notifications.js');

const config: NotificationConfig = { system: true };

function NotifHarness({
	groups,
	notifConfig,
}: {
	groups: readonly GroupStatus[];
	notifConfig: NotificationConfig;
}): ReactNode {
	useNotifications(groups, notifConfig);
	return React.createElement(Text, null, `groups:${groups.length}`);
}

describe('useNotifications', () => {
	it('does not fire notifications on first render', async () => {
		mockNotify.mockClear();
		const groups = [makeGroup({ step_result: 'needs-input' })];

		render(React.createElement(NotifHarness, { groups, notifConfig: config }));
		await act(async () => {});

		expect(mockNotify).not.toHaveBeenCalled();
	});

	it('fires notification when step_result changes after first render', async () => {
		mockNotify.mockClear();
		const initial = [makeGroup({ step_result: '' })];

		const { rerender } = render(
			React.createElement(NotifHarness, { groups: initial, notifConfig: config }),
		);
		await act(async () => {});

		// Simulate step_result change
		const updated = [makeGroup({ step_result: 'needs-input' })];
		await act(async () => {
			rerender(React.createElement(NotifHarness, { groups: updated, notifConfig: config }));
		});

		expect(mockNotify).toHaveBeenCalledOnce();
		expect(mockNotify).toHaveBeenCalledWith('pr-1: needs input', config);
	});

	it('does not fire when step_result is unchanged between renders', async () => {
		mockNotify.mockClear();
		const groups = [makeGroup({ step_result: '' })];

		const { rerender } = render(React.createElement(NotifHarness, { groups, notifConfig: config }));
		await act(async () => {});

		// Re-render with same step_result
		await act(async () => {
			rerender(React.createElement(NotifHarness, { groups, notifConfig: config }));
		});

		expect(mockNotify).not.toHaveBeenCalled();
	});

	it('does not fire for non-notification step_result changes', async () => {
		mockNotify.mockClear();
		const initial = [makeGroup({ step_result: '' })];

		const { rerender } = render(
			React.createElement(NotifHarness, { groups: initial, notifConfig: config }),
		);
		await act(async () => {});

		// Change to 'pass' — detectTransition returns null for this
		const updated = [makeGroup({ step_result: 'pass' })];
		await act(async () => {
			rerender(React.createElement(NotifHarness, { groups: updated, notifConfig: config }));
		});

		expect(mockNotify).not.toHaveBeenCalled();
	});
});
