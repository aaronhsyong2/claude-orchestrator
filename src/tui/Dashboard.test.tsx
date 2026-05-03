import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { GroupStatus } from '../types.js';
import { ActivityPanel } from './ActivityPanel.js';
import { Footer } from './Footer.js';
import { IssuesPanel } from './IssuesPanel.js';
import { MainView } from './MainView.js';
import { Panel } from './Panel.js';
import { PRGroupsPanel } from './PRGroupsPanel.js';
import { Sidebar } from './Sidebar.js';
import type { ActivityEvent } from './types.js';

function makeGroup(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-5',
		branch: 'feat/tui-dashboard',
		current_issue: 11,
		step: 'coding',
		step_result: '',
		issues_completed: [9],
		issues_remaining: [11, 12],
		last_updated: '2026-05-03T13:42:00.000Z',
		...overrides,
	};
}

describe('Panel', () => {
	it('renders with title', () => {
		const { lastFrame } = render(
			React.createElement(
				Panel,
				{ title: 'Test Panel', active: false },
				React.createElement(Text, null, 'content'),
			),
		);
		expect(lastFrame()).toContain('Test Panel');
		expect(lastFrame()).toContain('content');
	});

	it('renders active panel with green styling', () => {
		const { lastFrame } = render(
			React.createElement(
				Panel,
				{ title: 'Active', active: true },
				React.createElement(Text, null, 'body'),
			),
		);
		expect(lastFrame()).toContain('Active');
		expect(lastFrame()).toContain('body');
	});
});

describe('PRGroupsPanel', () => {
	it('shows empty state when no groups', () => {
		const { lastFrame } = render(
			React.createElement(PRGroupsPanel, { groups: [], active: true, selectedIndex: 0 }),
		);
		expect(lastFrame()).toContain('Waiting for work...');
	});

	it('shows groups with icons and progress', () => {
		const groups = [
			makeGroup({
				pr_group: 'pr-1',
				issues_completed: [1, 2],
				issues_remaining: [],
				step: 'idle',
				step_result: 'pass',
			}),
			makeGroup({
				pr_group: 'pr-5',
				issues_completed: [9],
				issues_remaining: [11, 12],
				step: 'coding',
			}),
		];
		const { lastFrame } = render(
			React.createElement(PRGroupsPanel, { groups, active: true, selectedIndex: 0 }),
		);
		const frame = lastFrame();
		expect(frame).toContain('pr-1');
		expect(frame).toContain('pr-5');
		expect(frame).toContain('2/2');
		expect(frame).toContain('1/3');
	});

	it('highlights selected item', () => {
		const groups = [makeGroup()];
		const { lastFrame } = render(
			React.createElement(PRGroupsPanel, { groups, active: true, selectedIndex: 0 }),
		);
		expect(lastFrame()).toContain('pr-5');
	});
});

describe('IssuesPanel', () => {
	it('shows empty state when no group selected', () => {
		const { lastFrame } = render(
			React.createElement(IssuesPanel, { group: null, active: false, selectedIndex: 0 }),
		);
		expect(lastFrame()).toContain('No group selected');
	});

	it('shows issues with status icons', () => {
		const { lastFrame } = render(
			React.createElement(IssuesPanel, { group: makeGroup(), active: true, selectedIndex: 0 }),
		);
		const frame = lastFrame();
		expect(frame).toContain('#9');
		expect(frame).toContain('#11');
		expect(frame).toContain('#12');
		expect(frame).toContain('[coding]');
	});

	it('shows no issues state', () => {
		const emptyGroup = makeGroup({ issues_completed: [], issues_remaining: [] });
		const { lastFrame } = render(
			React.createElement(IssuesPanel, { group: emptyGroup, active: false, selectedIndex: 0 }),
		);
		expect(lastFrame()).toContain('No issues');
	});
});

describe('ActivityPanel', () => {
	it('shows empty state', () => {
		const { lastFrame } = render(React.createElement(ActivityPanel, { events: [], active: false }));
		expect(lastFrame()).toContain('No activity yet');
	});

	it('shows events', () => {
		const events: ActivityEvent[] = [
			{ id: 1, timestamp: '13:42', message: '#11 coding' },
			{ id: 2, timestamp: '13:41', message: '#11 cloning' },
		];
		const { lastFrame } = render(React.createElement(ActivityPanel, { events, active: false }));
		const frame = lastFrame();
		expect(frame).toContain('13:42');
		expect(frame).toContain('#11 coding');
		expect(frame).toContain('13:41');
	});
});

describe('MainView', () => {
	it('shows waiting state when no group', () => {
		const { lastFrame } = render(React.createElement(MainView, { group: null }));
		expect(lastFrame()).toContain('Waiting for work...');
	});

	it('shows group detail', () => {
		const { lastFrame } = render(React.createElement(MainView, { group: makeGroup() }));
		const frame = lastFrame();
		expect(frame).toContain('feat/tui-dashboard');
		expect(frame).toContain('coding');
		expect(frame).toContain('1/3');
		expect(frame).toContain('#9');
		expect(frame).toContain('#11');
	});
});

describe('Footer', () => {
	it('shows keybinding hints', () => {
		const { lastFrame } = render(React.createElement(Footer));
		const frame = lastFrame();
		expect(frame).toContain('quit');
		expect(frame).toContain('select');
		expect(frame).toContain('panel');
	});
});

describe('Sidebar', () => {
	it('renders all three panels', () => {
		const groups = [makeGroup()];
		const events: ActivityEvent[] = [{ id: 1, timestamp: '13:42', message: 'test' }];
		const { lastFrame } = render(
			React.createElement(Sidebar, {
				groups,
				activePanel: 0,
				selectedGroupIndex: 0,
				selectedIssueIndex: 0,
				activity: events,
			}),
		);
		const frame = lastFrame();
		expect(frame).toContain('PR Groups');
		expect(frame).toContain('Issues');
		expect(frame).toContain('Activity');
	});

	it('renders empty state', () => {
		const { lastFrame } = render(
			React.createElement(Sidebar, {
				groups: [],
				activePanel: 0,
				selectedGroupIndex: 0,
				selectedIssueIndex: 0,
				activity: [],
			}),
		);
		const frame = lastFrame();
		expect(frame).toContain('Waiting for work...');
		expect(frame).toContain('No group selected');
		expect(frame).toContain('No activity yet');
	});
});
