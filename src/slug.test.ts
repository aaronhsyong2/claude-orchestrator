import { describe, expect, it } from 'vitest';
import { deriveSlug } from './slug.js';

describe('deriveSlug', () => {
	it('converts branch to lowercase slug', () => {
		expect(deriveSlug('feat/my-branch')).toBe('feat-my-branch');
	});

	it('replaces non-alphanumeric characters with hyphens', () => {
		expect(deriveSlug('feat/some_branch.name')).toBe('feat-some-branch-name');
	});

	it('trims leading and trailing hyphens', () => {
		expect(deriveSlug('feat/branch/')).toBe('feat-branch');
	});

	it('handles simple branch names', () => {
		expect(deriveSlug('main')).toBe('main');
	});

	it('throws on empty branch name', () => {
		expect(() => deriveSlug('')).toThrow('Branch name must not be empty');
	});

	it('throws on leading hyphen', () => {
		expect(() => deriveSlug('-feat/bad')).toThrow('must not start with a hyphen');
	});

	it('throws when slug resolves to empty', () => {
		expect(() => deriveSlug('///')).toThrow('produces an empty slug');
	});

	it('produces identical slugs for colliding branch names', () => {
		expect(deriveSlug('feat/my-branch')).toBe(deriveSlug('feat-my-branch'));
	});
});
