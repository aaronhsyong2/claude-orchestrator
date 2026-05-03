import { Box } from 'ink';
import type { ReactNode } from 'react';
import type { GroupStatus } from '../types.js';
import { ActivityPanel } from './ActivityPanel.js';
import { IssuesPanel } from './IssuesPanel.js';
import { PRGroupsPanel } from './PRGroupsPanel.js';
import type { ActivityEvent } from './types.js';

interface SidebarProps {
	readonly groups: readonly GroupStatus[];
	readonly activePanel: number;
	readonly selectedGroupIndex: number;
	readonly selectedGroup: GroupStatus | null;
	readonly selectedIssueIndex: number;
	readonly activity: readonly ActivityEvent[];
}

export function Sidebar({
	groups,
	activePanel,
	selectedGroupIndex,
	selectedGroup,
	selectedIssueIndex,
	activity,
}: SidebarProps): ReactNode {
	return (
		<Box flexDirection="column" flexGrow={1}>
			<PRGroupsPanel
				groups={groups}
				active={activePanel === 0}
				selectedIndex={selectedGroupIndex}
			/>
			<IssuesPanel
				group={selectedGroup}
				active={activePanel === 1}
				selectedIndex={selectedIssueIndex}
			/>
			<ActivityPanel events={activity} active={activePanel === 2} />
		</Box>
	);
}
