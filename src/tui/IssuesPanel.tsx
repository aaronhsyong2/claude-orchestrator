import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { GroupStatus } from '../types.js';
import { Panel } from './Panel.js';
import { getIssueIcon } from './status-icon.js';

interface IssuesPanelProps {
	readonly group: GroupStatus | null;
	readonly active: boolean;
	readonly selectedIndex: number;
}

export function IssuesPanel({ group, active, selectedIndex }: IssuesPanelProps): ReactNode {
	const title = group ? `Issues (${group.pr_group})` : 'Issues';

	if (!group) {
		return (
			<Panel title={title} active={active}>
				<Box marginLeft={1}>
					<Text dimColor>No group selected</Text>
				</Box>
			</Panel>
		);
	}

	const allIssues = [...group.issues_completed, ...group.issues_remaining];

	if (allIssues.length === 0) {
		return (
			<Panel title={title} active={active}>
				<Box marginLeft={1}>
					<Text dimColor>No issues</Text>
				</Box>
			</Panel>
		);
	}

	return (
		<Panel title={title} active={active}>
			{allIssues.map((issue, i) => {
				const { icon, stepLabel } = getIssueIcon(issue, group);
				const selected = i === selectedIndex;

				return (
					<Box key={issue} marginLeft={1}>
						<Text
							backgroundColor={selected && active ? 'blue' : undefined}
							bold={selected && !active}
						>
							{icon} #{issue}
							{stepLabel}
						</Text>
					</Box>
				);
			})}
		</Panel>
	);
}
