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
	const [readError, setReadError] = useState<string | null>(null);

	useEffect(() => {
		if (!groupSlug || !isValidSlug(groupSlug)) {
			setLines([]);
			setReadError(null);
			return;
		}

		const logDir = path.resolve(baseDir, '.orchestrator/logs', groupSlug);
		let active = true;

		async function refresh(): Promise<void> {
			const result = await readLatestLogLines(logDir, MAX_LINES);
			if (!active) return;
			if (result.error) {
				setReadError(result.error);
				setLines([]);
			} else {
				setReadError(null);
				setLines(result.lines);
			}
		}

		void refresh();
		const id = setInterval(() => void refresh(), POLL_MS);
		return () => {
			active = false;
			clearInterval(id);
		};
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
				{readError ? (
					<Text color="red">Log read failed: {readError}</Text>
				) : lines.length === 0 ? (
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

interface LogReadResult {
	readonly lines: readonly string[];
	readonly error?: string;
}

async function readLatestLogLines(logDir: string, maxLines: number): Promise<LogReadResult> {
	try {
		const entries = await fs.promises.readdir(logDir);
		const allLogs = entries.filter((f) => f.endsWith('.log'));

		if (allLogs.length === 0) return { lines: [] };

		// Prefer .readable.log files over raw .log files
		const readableLogs = allLogs.filter((f) => f.endsWith('.readable.log'));
		const targetFiles = readableLogs.length > 0 ? readableLogs : allLogs;
		const latest = targetFiles.sort((a, b) => {
			const numA = parseInt(a, 10);
			const numB = parseInt(b, 10);
			if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numB - numA;
			return b.localeCompare(a);
		})[0] as string;

		const content = await fs.promises.readFile(path.join(logDir, latest), 'utf-8');
		return { lines: content.split('\n').filter(Boolean).slice(-maxLines) };
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [] };
		const msg = err instanceof Error ? err.message : String(err);
		return { lines: [], error: msg };
	}
}
