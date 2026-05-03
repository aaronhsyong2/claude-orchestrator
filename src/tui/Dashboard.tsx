import { useScreenSize } from 'fullscreen-ink';
import { Box } from 'ink';
import type { ReactNode } from 'react';
import { DependencyGraphView } from './DependencyGraphView.js';
import { Footer } from './Footer.js';
import { LogTailView } from './LogTailView.js';
import { MainView } from './MainView.js';
import { Sidebar } from './Sidebar.js';
import { useKeyboard } from './use-keyboard.js';
import { useStatusPoller } from './use-status-poller.js';

interface DashboardProps {
	readonly baseDir: string;
	readonly pollInterval?: number;
}

export function Dashboard({ baseDir, pollInterval = 2000 }: DashboardProps): ReactNode {
	const { width, height } = useScreenSize();
	const { groups, activity } = useStatusPoller(baseDir, pollInterval);

	const { activePanel, selectedGroupIndex, selectedIssueIndex, screenMode, overlay } = useKeyboard({
		groups,
	});

	const selectedGroup = groups[selectedGroupIndex] ?? null;

	const sidebarWidth = screenMode === 'half' ? '50%' : '33%';
	const mainWidth = screenMode === 'full' ? '100%' : screenMode === 'half' ? '50%' : '67%';

	const mainContent =
		overlay === 'deps' ? (
			<DependencyGraphView groups={groups} />
		) : overlay === 'logs' ? (
			<LogTailView groupSlug={selectedGroup?.pr_group ?? null} baseDir={baseDir} />
		) : (
			<MainView group={selectedGroup} />
		);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box flexDirection="row" flexGrow={1}>
				{screenMode !== 'full' && (
					<Box width={sidebarWidth}>
						<Sidebar
							groups={groups}
							activePanel={activePanel}
							selectedGroupIndex={selectedGroupIndex}
							selectedIssueIndex={selectedIssueIndex}
							activity={activity}
						/>
					</Box>
				)}
				<Box width={mainWidth}>{mainContent}</Box>
			</Box>
			<Footer activePanel={activePanel} screenMode={screenMode} overlay={overlay} />
		</Box>
	);
}
