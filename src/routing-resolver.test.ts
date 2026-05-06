import { describe, expect, it } from 'vitest';
import { resolveRoute } from './routing-resolver.js';

describe('resolveRoute', () => {
	it('returns plan override when provided', () => {
		const result = resolveRoute({
			planOverride: '/prp-plan → /prp-implement',
			configRouting: { 'enhancement+ready-for-agent': '/tdd' },
			labels: ['enhancement', 'ready-for-agent'],
		});
		expect(result).toBe('/prp-plan → /prp-implement');
	});

	it('returns config routing match by sorted labels', () => {
		const result = resolveRoute({
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
			labels: ['ready-for-agent', 'bug'],
		});
		expect(result).toBe('/diagnose');
	});

	it('returns null when no override and no config', () => {
		expect(resolveRoute({})).toBeNull();
	});

	it('returns null when labels do not match any config key', () => {
		const result = resolveRoute({
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
			labels: ['enhancement'],
		});
		expect(result).toBeNull();
	});

	it('returns null when config routing exists but no labels provided', () => {
		const result = resolveRoute({
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
		});
		expect(result).toBeNull();
	});

	it('returns null when labels is an empty array', () => {
		const result = resolveRoute({
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
			labels: [],
		});
		expect(result).toBeNull();
	});

	it('returns null when labels partially match a multi-label key', () => {
		const result = resolveRoute({
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
			labels: ['bug'],
		});
		expect(result).toBeNull();
	});

	it('plan override takes precedence over config routing match', () => {
		const result = resolveRoute({
			planOverride: '/custom-skill',
			configRouting: { 'bug+ready-for-agent': '/diagnose' },
			labels: ['bug', 'ready-for-agent'],
		});
		expect(result).toBe('/custom-skill');
	});
});
