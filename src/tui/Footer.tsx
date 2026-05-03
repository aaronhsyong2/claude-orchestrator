import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { OverlayMode, ScreenMode, ShutdownStatus } from './types.js';

interface FooterProps {
	readonly activePanel: number;
	readonly screenMode: ScreenMode;
	readonly overlay: OverlayMode;
	readonly shutdownStatus: ShutdownStatus;
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

export function Footer({
	activePanel,
	screenMode,
	overlay,
	shutdownStatus,
}: FooterProps): ReactNode {
	if (shutdownStatus === 'exited') {
		return (
			<Box>
				<Text color="green">Orchestrator exited. Dashboard closing...</Text>
			</Box>
		);
	}
	if (shutdownStatus === 'force') {
		return (
			<Box>
				<Text color="yellow">Force killing workers...</Text>
			</Box>
		);
	}
	if (shutdownStatus === 'graceful') {
		return (
			<Box>
				<Text color="cyan">Shutting down -- waiting for workers... (q again to force kill)</Text>
			</Box>
		);
	}

	// Normal mode -- existing hint logic
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
