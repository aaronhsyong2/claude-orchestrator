import { ProgressBar } from '@inkjs/ui';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { GroupStatus } from '../types.js';
import { Panel } from './Panel.js';
import { getIssueIcon } from './status-icon.js';

interface MainViewProps {
	readonly group: GroupStatus | null;
}

export function MainView({ group }: MainViewProps): ReactNode {
	if (!group) {
		return (
			<Panel title="Detail" active={false}>
				<Box marginLeft={1} marginTop={1}>
					<Text dimColor>Waiting for work...</Text>
				</Box>
			</Panel>
		);
	}

	const total = group.issues_completed.length + group.issues_remaining.length;
	const done = group.issues_completed.length;
	const progress = total > 0 ? Math.round((done / total) * 100) : 0;
	const allIssues = [...group.issues_completed, ...group.issues_remaining];

	return (
		<Panel title={group.pr_group} active={false}>
			<Box flexDirection="column" marginLeft={1} gap={1}>
				<Box flexDirection="column">
					<Text>
						<Text bold>Branch: </Text>
						<Text>{group.branch}</Text>
					</Text>
					<Text>
						<Text bold>Step: </Text>
						<Text>{group.step}</Text>
					</Text>
					<Text>
						<Text bold>Progress: </Text>
						<Text>
							{done}/{total} issues
						</Text>
					</Text>
					<Box>
						<Box width={20}>
							<ProgressBar value={progress} />
						</Box>
					</Box>
				</Box>

				<Box flexDirection="column">
					<Text bold underline>
						Issues
					</Text>
					{allIssues.map((issue) => {
						const { icon, stepLabel } = getIssueIcon(issue, group);

						return (
							<Text key={issue}>
								{'  '}
								{icon} #{issue}
								{stepLabel}
							</Text>
						);
					})}
				</Box>

				<Text dimColor>Last updated: {group.last_updated}</Text>
			</Box>
		</Panel>
	);
}
