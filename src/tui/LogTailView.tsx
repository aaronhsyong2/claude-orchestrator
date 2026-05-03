import * as fs from 'node:fs';
import * as path from 'node:path';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { isValidSlug } from '../validation.js';
import { Panel } from './Panel.js';

interface LogTailViewProps {
	readonly groupSlug: string | null;
	readonly baseDir: string;
}

const MAX_LINES = 20;
const POLL_MS = 2000;

export function LogTailView({ groupSlug, baseDir }: LogTailViewProps): ReactNode {
	const [lines, setLines] = useState<readonly string[]>([]);

	useEffect(() => {
		if (!groupSlug || !isValidSlug(groupSlug)) {
			setLines([]);
			return;
		}

		const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);

		function refresh(): void {
			setLines(readLatestLogLines(logDir, MAX_LINES));
		}

		refresh();
		const id = setInterval(refresh, POLL_MS);
		return () => clearInterval(id);
	}, [groupSlug, baseDir]);

	if (!groupSlug) {
		return (
			<Panel title="Logs" active={false}>
				<Box marginLeft={1}>
					<Text dimColor>No group selected</Text>
				</Box>
			</Panel>
		);
	}

	if (!isValidSlug(groupSlug)) {
		return (
			<Panel title="Logs" active={false}>
				<Box marginLeft={1}>
					<Text color="red">Invalid group</Text>
				</Box>
			</Panel>
		);
	}

	return (
		<Panel title={`Logs (${groupSlug})`} active={false}>
			<Box flexDirection="column" marginLeft={1}>
				{lines.length === 0 ? (
					<Text dimColor>No logs</Text>
				) : (
					lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: display-only log lines
						<Text key={i} dimColor>
							{line}
						</Text>
					))
				)}
			</Box>
		</Panel>
	);
}

function readLatestLogLines(logDir: string, maxLines: number): readonly string[] {
	if (!fs.existsSync(logDir)) return [];

	const files = fs
		.readdirSync(logDir)
		.filter((f) => f.endsWith('.log'))
		.sort()
		.reverse();

	if (files.length === 0) return [];

	const latestLog = path.join(logDir, files[0] as string);
	try {
		const content = fs.readFileSync(latestLog, 'utf-8');
		return content.split('\n').filter(Boolean).slice(-maxLines);
	} catch {
		return [];
	}
}
