import { describe, expect, it } from 'vitest';
import { getGroupIcon, getStatusIcon } from './status-icon.js';

describe('getStatusIcon', () => {
	it('returns check for idle+pass', () => {
		expect(getStatusIcon('idle', 'pass')).toBe('\u2713');
	});

	it('returns pause for idle+blocked', () => {
		expect(getStatusIcon('idle', 'blocked')).toBe('\u23F8');
	});

	it('returns warning for idle+needs-input', () => {
		expect(getStatusIcon('idle', 'needs-input')).toBe('\u26A0');
	});

	it('returns dot for idle with no result', () => {
		expect(getStatusIcon('idle', '')).toBe('\u00B7');
	});

	it('returns gear for coding', () => {
		expect(getStatusIcon('coding', '')).toBe('\u2699');
	});

	it('returns gear for verifying', () => {
		expect(getStatusIcon('verifying', '')).toBe('\u2699');
	});

	it('returns gear for cloning', () => {
		expect(getStatusIcon('cloning', '')).toBe('\u2699');
	});

	it('returns gear for reviewing', () => {
		expect(getStatusIcon('reviewing', '')).toBe('\u2699');
	});
});

describe('getGroupIcon', () => {
	it('returns check when all done', () => {
		expect(getGroupIcon(3, 0, 'idle')).toBe('\u2713');
	});

	it('returns gear when step is active', () => {
		expect(getGroupIcon(1, 2, 'coding')).toBe('\u2699');
	});

	it('returns dot when idle and not started', () => {
		expect(getGroupIcon(0, 3, 'idle')).toBe('\u00B7');
	});

	it('returns dot when zero completed zero remaining', () => {
		expect(getGroupIcon(0, 0, 'idle')).toBe('\u00B7');
	});
});
