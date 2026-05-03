import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupStatus } from '../types.js';
import type { DashboardState, TakeoverRequest } from './types.js';
import { useKeyboard } from './use-keyboard.js';

// Mock worktree-manager and node:fs for path resolution and existence checks
vi.mock('../worktree-manager.js', () => ({
	getWorktreePath: vi.fn((branch: string, _baseDir?: string) => `/worktrees/${branch}`),
}));

const mockExistsSync = vi.fn(() => true);
vi.mock('node:fs', () => ({
	existsSync: (path: string) => mockExistsSync(path),
}));

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

function TestHarness({
	groups,
	baseDir,
	initialState,
	onTakeover,
	onQuit,
}: {
	groups: readonly GroupStatus[];
	baseDir?: string;
	initialState?: DashboardState;
	onTakeover?: (request: TakeoverRequest, state: DashboardState) => void;
	onQuit?: () => void;
}): ReactNode {
	const state = useKeyboard({ groups, baseDir, initialState, onTakeover, onQuit });
	return React.createElement(
		Text,
		null,
		`panel:${state.activePanel} group:${state.selectedGroupIndex} issue:${state.selectedIssueIndex} mode:${state.screenMode} overlay:${state.overlay} error:${state.error ?? 'null'}`,
	);
}

async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
	await act(async () => {
		stdin.write(key);
	});
}

const ENTER = '\r';

describe('useKeyboard', () => {
	beforeEach(() => {
		mockExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('starts with default state', () => {
		const groups = [makeGroup(), makeGroup({ pr_group: 'pr-2' }), makeGroup({ pr_group: 'pr-3' })];
		const { lastFrame } = render(React.createElement(TestHarness, { groups }));
		expect(lastFrame()).toContain('panel:0');
		expect(lastFrame()).toContain('group:0');
		expect(lastFrame()).toContain('mode:normal');
		expect(lastFrame()).toContain('overlay:none');
	});

	it('restores state from initialState', () => {
		const groups = [
			makeGroup({ pr_group: 'pr-1' }),
			makeGroup({ pr_group: 'pr-2' }),
			makeGroup({ pr_group: 'pr-3' }),
		];
		const initialState: DashboardState = {
			activePanel: 1,
			selectedGroupIndex: 2,
			selectedIssueIndex: 1,
			screenMode: 'half',
			overlay: 'deps',
		};
		const { lastFrame } = render(React.createElement(TestHarness, { groups, initialState }));
		expect(lastFrame()).toContain('panel:1');
		expect(lastFrame()).toContain('group:2');
		expect(lastFrame()).toContain('mode:half');
		expect(lastFrame()).toContain('overlay:deps');
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

	describe('Enter key (shell takeover)', () => {
		it('calls onTakeover with shell mode on Enter when on panel 0', async () => {
			const groups = [makeGroup({ branch: 'feat/my-branch' })];
			const onTakeover = vi.fn();
			const { stdin } = render(
				React.createElement(TestHarness, { groups, baseDir: '/repo', onTakeover }),
			);

			await press(stdin, ENTER);

			expect(onTakeover).toHaveBeenCalledOnce();
			const [request, state] = onTakeover.mock.calls[0] as [TakeoverRequest, DashboardState];
			expect(request.mode).toBe('shell');
			expect(request.branch).toBe('feat/my-branch');
			expect(request.worktreePath).toBe('/worktrees/feat/my-branch');
			expect(state.activePanel).toBe(0);
		});

		it('does not call onTakeover on Enter when on panel 1', async () => {
			const groups = [makeGroup()];
			const onTakeover = vi.fn();
			const { stdin } = render(React.createElement(TestHarness, { groups, onTakeover }));

			await press(stdin, '2'); // switch to panel 1
			await press(stdin, ENTER);

			expect(onTakeover).not.toHaveBeenCalled();
		});

		it('does not call onTakeover on Enter when no groups', async () => {
			const onTakeover = vi.fn();
			const { stdin } = render(React.createElement(TestHarness, { groups: [], onTakeover }));

			await press(stdin, ENTER);

			expect(onTakeover).not.toHaveBeenCalled();
		});

		it('shows error when worktree missing on Enter', async () => {
			mockExistsSync.mockReturnValue(false);
			const groups = [makeGroup({ branch: 'feat/missing' })];
			const onTakeover = vi.fn();
			const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups, onTakeover }));

			await press(stdin, ENTER);

			expect(onTakeover).not.toHaveBeenCalled();
			expect(lastFrame()).toContain('Worktree not found: feat/missing');
		});
	});

	describe('v key (nvim takeover)', () => {
		it('calls onTakeover with nvim mode on v when on panel 0', async () => {
			const groups = [makeGroup({ branch: 'feat/my-branch' })];
			const onTakeover = vi.fn();
			const { stdin } = render(
				React.createElement(TestHarness, { groups, baseDir: '/repo', onTakeover }),
			);

			await press(stdin, 'v');

			expect(onTakeover).toHaveBeenCalledOnce();
			const [request] = onTakeover.mock.calls[0] as [TakeoverRequest, DashboardState];
			expect(request.mode).toBe('nvim');
			expect(request.branch).toBe('feat/my-branch');
		});

		it('does not call onTakeover on v when on panel 1', async () => {
			const groups = [makeGroup()];
			const onTakeover = vi.fn();
			const { stdin } = render(React.createElement(TestHarness, { groups, onTakeover }));

			await press(stdin, '2');
			await press(stdin, 'v');

			expect(onTakeover).not.toHaveBeenCalled();
		});

		it('does not call onTakeover on v when no groups', async () => {
			const onTakeover = vi.fn();
			const { stdin } = render(React.createElement(TestHarness, { groups: [], onTakeover }));

			await press(stdin, 'v');

			expect(onTakeover).not.toHaveBeenCalled();
		});

		it('shows error when worktree missing on v', async () => {
			mockExistsSync.mockReturnValue(false);
			const groups = [makeGroup({ branch: 'feat/missing' })];
			const onTakeover = vi.fn();
			const { lastFrame, stdin } = render(React.createElement(TestHarness, { groups, onTakeover }));

			await press(stdin, 'v');

			expect(onTakeover).not.toHaveBeenCalled();
			expect(lastFrame()).toContain('Worktree not found: feat/missing');
		});
	});

	describe('q key (quit)', () => {
		it('calls onQuit when provided', async () => {
			const groups = [makeGroup()];
			const onQuit = vi.fn();
			const { stdin } = render(React.createElement(TestHarness, { groups, onQuit }));

			await press(stdin, 'q');

			expect(onQuit).toHaveBeenCalledOnce();
		});
	});
});
