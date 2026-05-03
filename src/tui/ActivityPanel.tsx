import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { Panel } from './Panel.js';
import type { ActivityEvent } from './types.js';

interface ActivityPanelProps {
	readonly events: readonly ActivityEvent[];
	readonly active: boolean;
}

const MAX_VISIBLE = 10;

export function ActivityPanel({ events, active }: ActivityPanelProps): ReactNode {
	if (events.length === 0) {
		return (
			<Panel title="Activity" active={active}>
				<Box marginLeft={1}>
					<Text dimColor>No activity yet</Text>
				</Box>
			</Panel>
		);
	}

	const visible = events.slice(0, MAX_VISIBLE);

	return (
		<Panel title="Activity" active={active}>
			{visible.map((event) => (
				<Box key={event.id} marginLeft={1}>
					<Text dimColor>{event.timestamp}</Text>
					<Text> {event.message}</Text>
				</Box>
			))}
		</Panel>
	);
}
