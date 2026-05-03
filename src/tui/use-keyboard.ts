import { existsSync } from 'node:fs';
import { useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { GroupStatus } from '../types.js';
import { getWorktreePath } from '../worktree-manager.js';
import type { DashboardState, OverlayMode, ScreenMode, TakeoverRequest } from './types.js';

interface UseKeyboardOptions {
	readonly groups: readonly GroupStatus[];
	readonly baseDir?: string;
	readonly initialState?: DashboardState;
	readonly onTakeover?: (request: TakeoverRequest, state: DashboardState) => void;
	readonly onQuit?: () => void;
}

interface KeyboardState {
	readonly activePanel: number;
	readonly selectedGroupIndex: number;
	readonly selectedIssueIndex: number;
	readonly screenMode: ScreenMode;
	readonly overlay: OverlayMode;
	readonly error: string | null;
}

export function useKeyboard({
	groups,
	baseDir = '.',
	initialState,
	onTakeover,
	onQuit,
}: UseKeyboardOptions): KeyboardState {
	const { exit } = useApp();
	const [activePanel, setActivePanel] = useState(initialState?.activePanel ?? 0);
	const [selectedGroupIndex, setSelectedGroupIndex] = useState(
		initialState?.selectedGroupIndex ?? 0,
	);
	const [selectedIssueIndex, setSelectedIssueIndex] = useState(
		initialState?.selectedIssueIndex ?? 0,
	);
	const [screenMode, setScreenMode] = useState<ScreenMode>(initialState?.screenMode ?? 'normal');
	const [overlay, setOverlay] = useState<OverlayMode>(initialState?.overlay ?? 'none');
	const [error, setError] = useState<string | null>(null);

	const groupCount = groups.length;
	const selectedGroup = groups[selectedGroupIndex];
	const issueCount = selectedGroup
		? selectedGroup.issues_completed.length + selectedGroup.issues_remaining.length
		: 0;

	// Reset issue index when group selection changes (selectedGroupIndex is the trigger, not read)
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedGroupIndex is intentional trigger
	useEffect(() => {
		setSelectedIssueIndex(0);
	}, [selectedGroupIndex]);

	// Clamp group index when group count shrinks
	useEffect(() => {
		if (groupCount > 0 && selectedGroupIndex >= groupCount) {
			setSelectedGroupIndex(groupCount - 1);
		}
	}, [groupCount, selectedGroupIndex]);

	// Clamp issue index when issue count shrinks
	useEffect(() => {
		if (issueCount > 0 && selectedIssueIndex >= issueCount) {
			setSelectedIssueIndex(issueCount - 1);
		}
	}, [issueCount, selectedIssueIndex]);

	function currentState(): DashboardState {
		return { activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay };
	}

	function navigateDown(): void {
		if (activePanel === 0) {
			setSelectedGroupIndex((prev) => (groupCount === 0 ? 0 : (prev + 1) % groupCount));
		} else if (activePanel === 1) {
			setSelectedIssueIndex((prev) => (issueCount === 0 ? 0 : (prev + 1) % issueCount));
		}
	}

	function navigateUp(): void {
		if (activePanel === 0) {
			setSelectedGroupIndex((prev) =>
				groupCount === 0 ? 0 : (prev - 1 + groupCount) % groupCount,
			);
		} else if (activePanel === 1) {
			setSelectedIssueIndex((prev) =>
				issueCount === 0 ? 0 : (prev - 1 + issueCount) % issueCount,
			);
		}
	}

	useInput((input, key) => {
		if (input === '1') {
			setActivePanel(0);
			return;
		}
		if (input === '2') {
			setActivePanel(1);
			return;
		}
		if (input === '3') {
			setActivePanel(2);
			return;
		}

		if (input === 'j' || key.downArrow) {
			navigateDown();
			return;
		}
		if (input === 'k' || key.upArrow) {
			navigateUp();
			return;
		}

		if (input === '+') {
			setScreenMode((prev) => {
				const modes: readonly ScreenMode[] = ['normal', 'half', 'full'];
				const idx = modes.indexOf(prev);
				return modes[(idx + 1) % modes.length] ?? 'normal';
			});
			return;
		}

		// OverlayMode is a single value; toggling one key naturally replaces the other
		if (input === 'd') {
			setOverlay((prev) => (prev === 'deps' ? 'none' : 'deps'));
			return;
		}
		if (input === 'l') {
			setOverlay((prev) => (prev === 'logs' ? 'none' : 'logs'));
			return;
		}

		if (key.return && activePanel === 0) {
			const group = groups[selectedGroupIndex];
			if (!group) return;
			const worktreePath = getWorktreePath(group.branch, baseDir);
			if (!existsSync(worktreePath)) {
				setError(`Worktree not found: ${group.branch}`);
				setTimeout(() => setError(null), 3000);
				return;
			}
			onTakeover?.({ mode: 'shell', worktreePath, branch: group.branch }, currentState());
			return;
		}

		if (input === 'v' && activePanel === 0) {
			const group = groups[selectedGroupIndex];
			if (!group) return;
			const worktreePath = getWorktreePath(group.branch, baseDir);
			if (!existsSync(worktreePath)) {
				setError(`Worktree not found: ${group.branch}`);
				setTimeout(() => setError(null), 3000);
				return;
			}
			onTakeover?.({ mode: 'nvim', worktreePath, branch: group.branch }, currentState());
			return;
		}

		if (input === 'q') {
			if (onQuit) {
				onQuit();
			} else {
				exit();
			}
			return;
		}
	});

	return { activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay, error };
}
