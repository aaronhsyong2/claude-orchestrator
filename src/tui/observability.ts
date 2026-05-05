/**
 * Pure observability helpers for TUI dashboard.
 * Elapsed time formatting and stale detection — no TUI dependencies.
 */

import type { GroupStatus } from '../types.js';

export function formatElapsed(startIso: string, nowIso: string): string {
	const diffMs = Math.max(0, new Date(nowIso).getTime() - new Date(startIso).getTime());
	const totalSeconds = Math.floor(diffMs / 1000);

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function isStale(lastActivityIso: string, nowIso: string, thresholdMs: number): boolean {
	const elapsed = new Date(nowIso).getTime() - new Date(lastActivityIso).getTime();
	return elapsed >= thresholdMs;
}

// Steps where elapsed time and stale detection are not meaningful.
// pr-creating/pr-reviewing intentionally excluded — we want stale detection there.
const TERMINAL_STEPS = new Set(['idle', 'awaiting-merge']);

export function formatStepLabel(
	step: string,
	stepStartIso: string | null,
	lastActivityIso: string | null,
	nowIso: string,
	staleThresholdMs: number,
): string {
	if (!stepStartIso || TERMINAL_STEPS.has(step)) return step;

	const elapsed = formatElapsed(stepStartIso, nowIso);
	const activityRef = lastActivityIso ?? stepStartIso;
	const stale = isStale(activityRef, nowIso, staleThresholdMs);

	return stale ? `${step} (${elapsed}) \u26A0 no activity` : `${step} (${elapsed})`;
}

export function trackStepStarts(
	prevStarts: ReadonlyMap<string, string>,
	nextGroups: readonly GroupStatus[],
	nowIso: string,
	prevGroups?: readonly GroupStatus[],
): Map<string, string> {
	const prevStepMap = new Map((prevGroups ?? []).map((g) => [g.pr_group, g.step]));
	const result = new Map<string, string>();

	for (const group of nextGroups) {
		const prevStart = prevStarts.get(group.pr_group);
		const prevStep = prevStepMap.get(group.pr_group);

		if (!prevStart || prevStep !== group.step) {
			result.set(group.pr_group, nowIso);
		} else {
			result.set(group.pr_group, prevStart);
		}
	}

	return result;
}

const ACTIVITY_MAX_LEN = 80;

const TOOL_VERBS: ReadonlyMap<string, string> = new Map([
	['Read', 'Reading'],
	['Edit', 'Editing'],
	['Write', 'Writing'],
	['Bash', 'Running'],
]);

export function parseToolUseActivity(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	if (obj.type !== 'tool_use') return null;

	const name = String(obj.name ?? '');
	const input = obj.input as Record<string, unknown> | undefined;

	if (input) {
		if (typeof input.file_path === 'string') {
			const verb = TOOL_VERBS.get(name) ?? name;
			return `${verb} ${input.file_path}`;
		}
		if (typeof input.command === 'string') {
			const verb = TOOL_VERBS.get(name) ?? name;
			const full = `${verb} ${input.command}`;
			return full.length > ACTIVITY_MAX_LEN ? `${full.slice(0, ACTIVITY_MAX_LEN - 1)}\u2026` : full;
		}
		if (typeof input.pattern === 'string') {
			return `${name} ${input.pattern}`;
		}
	}

	return name;
}
