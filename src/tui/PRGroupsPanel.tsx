import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { GroupStatus } from '../types.js';
import { Panel } from './Panel.js';
import { getGroupIcon, getStatusIcon } from './status-icon.js';

interface PRGroupsPanelProps {
	readonly groups: readonly GroupStatus[];
	readonly active: boolean;
	readonly selectedIndex: number;
	readonly stepLabels?: ReadonlyMap<string, string>;
}

export function PRGroupsPanel({
	groups,
	active,
	selectedIndex,
	stepLabels,
}: PRGroupsPanelProps): ReactNode {
	if (groups.length === 0) {
		return (
			<Panel title="PR Groups" active={active}>
				<Box marginLeft={1}>
					<Text dimColor>Waiting for work...</Text>
				</Box>
			</Panel>
		);
	}

	return (
		<Panel title="PR Groups" active={active}>
			{groups.map((group, i) => {
				const icon =
					group.step === 'idle' && group.step_result
						? getStatusIcon(group.step, group.step_result)
						: getGroupIcon(
								group.issues_completed.length,
								group.issues_remaining.length,
								group.step,
							);
				const selected = i === selectedIndex;
				const total = group.issues_completed.length + group.issues_remaining.length;
				const done = group.issues_completed.length;

				const label = stepLabels?.get(group.pr_group);

				return (
					<Box key={group.pr_group} marginLeft={1}>
						<Text
							backgroundColor={selected && active ? 'blue' : undefined}
							bold={selected && !active}
						>
							{icon} {group.pr_group} ({done}/{total})
						</Text>
						{label ? <Text dimColor> {label}</Text> : null}
					</Box>
				);
			})}
		</Panel>
	);
}
