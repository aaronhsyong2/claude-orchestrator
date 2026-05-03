import { existsSync } from 'node:fs';
import { useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { isProcessAlive, readLock } from '../lock.js';
import { readShutdownFile, writeShutdownFile } from '../shutdown.js';
import type { GroupStatus } from '../types.js';
import { getWorktreePath } from '../worktree-manager.js';
import type {
	DashboardState,
	OverlayMode,
	PanelIndex,
	ScreenMode,
	ShutdownStatus,
	TakeoverRequest,
} from './types.js';

interface UseKeyboardOptions {
	readonly groups: readonly GroupStatus[];
	readonly baseDir?: string;
	readonly initialState?: DashboardState;
	readonly onTakeover?: (request: TakeoverRequest, state: DashboardState) => void;
	readonly onQuit?: () => void;
}

interface KeyboardState {
	readonly activePanel: PanelIndex;
	readonly selectedGroupIndex: number;
	readonly selectedIssueIndex: number;
	readonly screenMode: ScreenMode;
	readonly overlay: OverlayMode;
	readonly error: string | null;
	readonly shutdownStatus: ShutdownStatus;
}

export function useKeyboard({
	groups,
	baseDir = '.',
	initialState,
	onTakeover,
	onQuit,
}: UseKeyboardOptions): KeyboardState {
	const { exit } = useApp();
	const [activePanel, setActivePanel] = useState<PanelIndex>(initialState?.activePanel ?? 0);
	const [selectedGroupIndex, setSelectedGroupIndex] = useState(
		initialState?.selectedGroupIndex ?? 0,
	);
	const [selectedIssueIndex, setSelectedIssueIndex] = useState(
		initialState?.selectedIssueIndex ?? 0,
	);
	const [screenMode, setScreenMode] = useState<ScreenMode>(initialState?.screenMode ?? 'normal');
	const [overlay, setOverlay] = useState<OverlayMode>(initialState?.overlay ?? 'none');
	const [error, setError] = useState<string | null>(null);
	const [shutdownStatus, setShutdownStatus] = useState<ShutdownStatus>(
		initialState?.shutdownStatus ?? 'none',
	);
	const lastQPressRef = useRef<number>(0);
	const DOUBLE_Q_THRESHOLD_MS = 2000;

	// Auto-dismiss error after 3 seconds
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(null), 3000);
		return () => clearTimeout(timer);
	}, [error]);

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

	// Poll lock file after shutdown requested to detect orchestrator exit
	useEffect(() => {
		if (shutdownStatus === 'none' || shutdownStatus === 'exited') return;
		const timer = setInterval(() => {
			const pid = readLock(baseDir);
			if (pid === null || !isProcessAlive(pid)) {
				setShutdownStatus('exited');
				clearInterval(timer);
				return;
			}
			// Re-read shutdown file in case mode upgraded from graceful to force
			const signal = readShutdownFile(baseDir);
			if (signal?.mode === 'force' && shutdownStatus === 'graceful') {
				setShutdownStatus('force');
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [shutdownStatus, baseDir]);

	// Auto-exit dashboard after showing "exited" status briefly
	useEffect(() => {
		if (shutdownStatus !== 'exited') return;
		const timer = setTimeout(() => {
			if (onQuit) {
				onQuit();
			} else {
				exit();
			}
		}, 1500);
		return () => clearTimeout(timer);
	}, [shutdownStatus, onQuit, exit]);

	const stateRef = useRef<DashboardState>({
		activePanel,
		selectedGroupIndex,
		selectedIssueIndex,
		screenMode,
		overlay,
		shutdownStatus,
	});

	useEffect(() => {
		stateRef.current = {
			activePanel,
			selectedGroupIndex,
			selectedIssueIndex,
			screenMode,
			overlay,
			shutdownStatus,
		};
	}, [activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay, shutdownStatus]);

	function currentState(): DashboardState {
		return stateRef.current;
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
		const panelKey = Number(input) - 1;
		if (panelKey >= 0 && panelKey <= 2) {
			setActivePanel(panelKey as PanelIndex);
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

		if ((key.return || input === 'v') && activePanel === 0) {
			const mode = key.return ? 'shell' : 'nvim';
			const group = groups[selectedGroupIndex];
			if (!group) return;
			const worktreePath = getWorktreePath(group.branch, baseDir);
			if (!existsSync(worktreePath)) {
				setError(`Worktree not found: ${group.branch}`);
				return;
			}
			onTakeover?.({ mode, worktreePath, branch: group.branch }, currentState());
			return;
		}

		if (input === 'q') {
			const now = Date.now();
			const elapsed = now - lastQPressRef.current;
			lastQPressRef.current = now;

			if (shutdownStatus !== 'none') {
				// Already in shutdown -- subsequent q within threshold upgrades to force
				if (elapsed < DOUBLE_Q_THRESHOLD_MS) {
					try {
						writeShutdownFile('force', baseDir);
						setShutdownStatus('force');
					} catch (err) {
						setError(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return;
			}

			// First q -- graceful shutdown
			try {
				writeShutdownFile('graceful', baseDir);
				setShutdownStatus('graceful');
			} catch (err) {
				setError(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
	});

	return {
		activePanel,
		selectedGroupIndex,
		selectedIssueIndex,
		screenMode,
		overlay,
		error,
		shutdownStatus,
	};
}
