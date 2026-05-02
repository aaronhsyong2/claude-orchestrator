import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentState, StatusEntry } from './types.js';

const SLUG_COL_WIDTH = 24;
const STATE_COL_WIDTH = 14;
const VALID_STATES: readonly AgentState[] = ['queued', 'in_progress', 'done', 'failed'];

export function getStatusDir(baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/status');
}

function isValidStatusEntry(value: unknown): value is StatusEntry {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.slug === 'string' &&
		typeof obj.state === 'string' &&
		VALID_STATES.includes(obj.state as AgentState) &&
		typeof obj.issues_total === 'number' &&
		typeof obj.issues_done === 'number'
	);
}

export function readStatusFiles(baseDir?: string): readonly StatusEntry[] {
	const statusDir = getStatusDir(baseDir);

	if (!fs.existsSync(statusDir)) {
		return [];
	}

	const files = fs.readdirSync(statusDir).filter((f) => f.endsWith('.json'));
	const entries: StatusEntry[] = [];

	for (const file of files) {
		try {
			const content = fs.readFileSync(path.join(statusDir, path.basename(file)), 'utf-8');
			const parsed: unknown = JSON.parse(content);
			if (isValidStatusEntry(parsed)) {
				entries.push(parsed);
			} else {
				process.stderr.write(`Warning: skipping malformed status file ${file}\n`);
			}
		} catch {
			process.stderr.write(`Warning: skipping invalid status file ${file}\n`);
		}
	}

	return entries;
}

export function formatStatus(entries: readonly StatusEntry[]): string {
	if (entries.length === 0) {
		return 'No active work.';
	}

	const lines = ['=== Orchestrator Status ==='];
	for (const entry of entries) {
		const slug = entry.slug.padEnd(SLUG_COL_WIDTH);
		const state = entry.state.padEnd(STATE_COL_WIDTH);
		lines.push(`  ${slug}${state}${entry.issues_done}/${entry.issues_total} issues done`);
	}
	return lines.join('\n');
}

export function printStatus(baseDir?: string): void {
	const entries = readStatusFiles(baseDir);
	process.stdout.write(`${formatStatus(entries)}\n`);
}
