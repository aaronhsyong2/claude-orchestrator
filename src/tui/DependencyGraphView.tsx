import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { GroupStatus } from '../types.js';
import { Panel } from './Panel.js';
import { getGroupIcon } from './status-icon.js';

interface DependencyGraphViewProps {
	readonly groups: readonly GroupStatus[];
}

export function DependencyGraphView({ groups }: DependencyGraphViewProps): ReactNode {
	if (groups.length === 0) {
		return (
			<Panel title="Dependency Graph" active={false}>
				<Box marginLeft={1}>
					<Text dimColor>No groups</Text>
				</Box>
			</Panel>
		);
	}

	return (
		<Panel title="Dependency Graph" active={false}>
			<Box flexDirection="column" marginLeft={1}>
				{groups.map((group, i) => {
					const icon = getGroupIcon(
						group.issues_completed.length,
						group.issues_remaining.length,
						group.step,
					);
					const connector = i < groups.length - 1 ? '├── ' : '└── ';
					const pipe = i < groups.length - 1 ? '│' : ' ';

					return (
						<Box key={group.pr_group} flexDirection="column">
							<Text>
								{connector}
								{icon} {group.pr_group}
							</Text>
							{i < groups.length - 1 && <Text dimColor>{pipe}</Text>}
						</Box>
					);
				})}
			</Box>
		</Panel>
	);
}
