import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { OverlayMode, ScreenMode } from './types.js';

interface FooterProps {
	readonly activePanel: number;
	readonly screenMode: ScreenMode;
	readonly overlay: OverlayMode;
}

const NEXT_MODE: Record<ScreenMode, ScreenMode> = {
	normal: 'half',
	half: 'full',
	full: 'normal',
};

const JK_LABEL: Record<number, string> = {
	0: 'group',
	1: 'issue',
};

function getHints(
	activePanel: number,
	screenMode: ScreenMode,
	overlay: OverlayMode,
): readonly (readonly [string, string])[] {
	const jkLabel = JK_LABEL[activePanel];
	const hints: (readonly [string, string])[] = [
		['1-3', 'panel'],
		...(jkLabel ? [['j/k', jkLabel] as const] : []),
		...(activePanel === 0 ? [['↵', 'shell'] as const, ['v', 'nvim'] as const] : []),
		['+', `layout:${NEXT_MODE[screenMode]}`],
		['d', overlay === 'deps' ? 'deps:on' : 'deps'],
		['l', overlay === 'logs' ? 'logs:on' : 'logs'],
		['q', 'quit'],
	];
	return hints;
}

export function Footer({ activePanel, screenMode, overlay }: FooterProps): ReactNode {
	const hints = getHints(activePanel, screenMode, overlay);
	return (
		<Box>
			{hints.map(([key, label], i) => (
				<Box key={`${key}-${label}`} marginRight={1}>
					{i > 0 && <Text dimColor> | </Text>}
					<Text bold>{key}</Text>
					<Text dimColor> {label}</Text>
				</Box>
			))}
		</Box>
	);
}
