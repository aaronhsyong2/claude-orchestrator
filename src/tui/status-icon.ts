import type { GroupStep } from '../types.js';
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
