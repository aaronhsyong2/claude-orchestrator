import type { GroupStatus, GroupStep } from '../types.js';
import type { StatusIconChar } from './types.js';

export function getStatusIcon(step: GroupStep, result: string): StatusIconChar {
	if (step === 'idle' && result === 'pass') return '\u2713';
	if (step === 'idle' && result === 'blocked') return '\u23F8';
	if (step === 'idle' && result === 'needs-input') return '\u26A0';
	if (step === 'idle') return '\u00B7';
	return '\u2699';
}

export function getGroupIcon(
	completed: number,
	remaining: number,
	step: GroupStep,
): StatusIconChar {
	if (remaining === 0 && completed > 0) return '\u2713';
	if (step !== 'idle') return '\u2699';
	return '\u00B7';
}

export interface IssueIconResult {
	readonly icon: StatusIconChar;
	readonly stepLabel: string;
}

export function getIssueIcon(issue: number, group: GroupStatus): IssueIconResult {
	const isCompleted = group.issues_completed.includes(issue);
	const isCurrent = issue === group.current_issue;
	const step = isCompleted ? 'idle' : isCurrent ? group.step : 'idle';
	const result = isCompleted ? 'pass' : '';
	const icon = getStatusIcon(step, result);
	const stepLabel = isCurrent && group.step !== 'idle' ? ` [${group.step}]` : '';
	return { icon, stepLabel };
}
