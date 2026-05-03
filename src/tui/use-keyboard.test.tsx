import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { GroupStatus } from '../types.js';
import { useKeyboard } from './use-keyboard.js';

function makeGroup(overrides?: Partial<GroupStatus>): GroupStatus {
	return {
		pr_group: 'pr-5',
		branch: 'feat/test',
		current_issue: 1,
		step: 'coding',
		step_result: '',
		issues_completed: [1],
		issues_remaining: [2, 3],
		last_updated: '2026-05-03T00:00:00.000Z',
		...overrides,
	};
}

function TestHarness({ groups }: { groups: readonly GroupStatus[] }): ReactNode {
	const state = useKeyboard({ groups });
	return React.createElement(
		Text,
		null,
		`panel:${state.activePanel} group:${state.selectedGroupIndex} issue:${state.selectedIssueIndex} mode:${state.screenMode} overlay:${state.overlay}`,
	);
}

async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
	await act(async () => {
		stdin.write(key);
	});
}

describe('useKeyboard', () => {
	it('starts with default state', () => {
		const groups = [makeGroup(), makeGroup({ pr_group: 'pr-2' }), makeGroup({ pr_group: 'pr-3' })];
		const { lastFrame } = render(React.createElement(TestHarness, { groups }));
		expect(lastFrame()).toContain('panel:0');
		expect(lastFrame()).toContain('group:0');
		expect(lastFrame()).toContain('mode:normal');
		expect(lastFrame()).toContain('overlay:none');
	});

	it('switches panels with 1/2/3', async () => {
		const groups = [makeGroup(), makeGroup({ pr_group: 'pr-2' }), makeGroup({ pr_group: 'pr-3' })];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, '2');
		expect(lastFrame()).toContain('panel:1');
		await press(stdin, '3');
		expect(lastFrame()).toContain('panel:2');
		await press(stdin, '1');
		expect(lastFrame()).toContain('panel:0');
	});

	it('navigates groups with j/k', async () => {
		const groups = [
			makeGroup({ pr_group: 'pr-1' }),
			makeGroup({ pr_group: 'pr-2' }),
			makeGroup({ pr_group: 'pr-3' }),
		];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, 'j');
		expect(lastFrame()).toContain('group:1');
		await press(stdin, 'j');
		expect(lastFrame()).toContain('group:2');
		// Wraps at bottom
		await press(stdin, 'j');
		expect(lastFrame()).toContain('group:0');
		// k wraps at top
		await press(stdin, 'k');
		expect(lastFrame()).toContain('group:2');
	});

	it('navigates issues in panel 1', async () => {
		const groups = [
			makeGroup({
				pr_group: 'pr-1',
				issues_completed: [1],
				issues_remaining: [2, 3, 4],
			}),
		];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, '2'); // Switch to issues panel
		await press(stdin, 'j');
		expect(lastFrame()).toContain('issue:1');
		await press(stdin, 'j');
		expect(lastFrame()).toContain('issue:2');
	});

	it('cycles screen modes with +', async () => {
		const groups = [makeGroup()];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, '+');
		expect(lastFrame()).toContain('mode:half');
		await press(stdin, '+');
		expect(lastFrame()).toContain('mode:full');
		await press(stdin, '+');
		expect(lastFrame()).toContain('mode:normal');
	});

	it('toggles dependency graph overlay with d', async () => {
		const groups = [makeGroup()];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, 'd');
		expect(lastFrame()).toContain('overlay:deps');
		await press(stdin, 'd');
		expect(lastFrame()).toContain('overlay:none');
	});

	it('toggles log overlay with l', async () => {
		const groups = [makeGroup()];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, 'l');
		expect(lastFrame()).toContain('overlay:logs');
		await press(stdin, 'l');
		expect(lastFrame()).toContain('overlay:none');
	});

	it('d and l are mutually exclusive', async () => {
		const groups = [makeGroup()];
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups }));
		await press(stdin, 'd');
		expect(lastFrame()).toContain('overlay:deps');
		await press(stdin, 'l');
		expect(lastFrame()).toContain('overlay:logs');
		await press(stdin, 'd');
		expect(lastFrame()).toContain('overlay:deps');
	});

	it('does not navigate when group count is 0', async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups: [] }));
		await press(stdin, 'j');
		expect(lastFrame()).toContain('group:0');
	});
});
