import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

const HINTS: readonly (readonly [string, string])[] = [
	['q', 'quit'],
	['\u2191\u2193', 'select'],
	['\u2190\u2192', 'panel'],
	['enter', 'details'],
];

export function Footer(): ReactNode {
	return (
		<Box>
			{HINTS.map(([key, label], i) => (
				<Box key={key} marginRight={1}>
					{i > 0 && <Text dimColor> | </Text>}
					<Text bold>{key}</Text>
					<Text dimColor> {label}</Text>
				</Box>
			))}
		</Box>
	);
}
