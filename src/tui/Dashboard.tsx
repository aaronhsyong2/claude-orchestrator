import { useScreenSize } from 'fullscreen-ink';
import { Box } from 'ink';
import type { ReactNode } from 'react';
import { Footer } from './Footer.js';
import { MainView } from './MainView.js';
import { Sidebar } from './Sidebar.js';
import { useStatusPoller } from './use-status-poller.js';

interface DashboardProps {
	readonly baseDir: string;
	readonly pollInterval?: number;
}

export function Dashboard({ baseDir, pollInterval = 2000 }: DashboardProps): ReactNode {
	const { width, height } = useScreenSize();
	const { groups, activity } = useStatusPoller(baseDir, pollInterval);

	const selectedGroup = groups[0] ?? null;

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box flexDirection="row" flexGrow={1}>
				<Box width="33%">
					<Sidebar
						groups={groups}
						activePanel={0}
						selectedGroupIndex={0}
						selectedIssueIndex={0}
						activity={activity}
					/>
				</Box>
				<Box width="67%">
					<MainView group={selectedGroup} />
				</Box>
			</Box>
			<Footer />
		</Box>
	);
}
