import { Box, Text } from 'ink';
import type { PropsWithChildren, ReactNode } from 'react';

interface PanelOwnProps {
	readonly title: string;
	readonly active: boolean;
	readonly height?: number | string;
}

type PanelProps = PropsWithChildren<PanelOwnProps>;

export function Panel({ title, active, children, height }: PanelProps): ReactNode {
	return (
		<Box
			flexDirection="column"
			borderStyle={active ? 'bold' : 'single'}
			borderColor={active ? 'green' : undefined}
			borderDimColor={!active}
			height={height}
			overflow="hidden"
		>
			<Box marginLeft={1}>
				<Text bold={active} color={active ? 'green' : undefined}>
					{title}
				</Text>
			</Box>
			{children}
		</Box>
	);
}
