import { describe, expect, it } from 'vitest';
import { assertValidIssue, assertValidSlug, isValidSlug } from './validation.js';

describe('isValidSlug', () => {
	it('returns true for valid slug', () => expect(isValidSlug('pr-1')).toBe(true));
	it('returns true for alphanumeric slug', () => expect(isValidSlug('my-feature-123')).toBe(true));
	it('returns false for traversal slug', () => expect(isValidSlug('../../etc/passwd')).toBe(false));
	it('returns false for empty string', () => expect(isValidSlug('')).toBe(false));
	it('returns false for leading hyphen', () => expect(isValidSlug('-bad')).toBe(false));
});

describe('assertValidSlug', () => {
	it('accepts valid slugs', () => {
		expect(() => assertValidSlug('pr-1')).not.toThrow();
		expect(() => assertValidSlug('my-feature-123')).not.toThrow();
		expect(() => assertValidSlug('a')).not.toThrow();
	});

	it('rejects empty string', () => {
		expect(() => assertValidSlug('')).toThrow(/Invalid slug/);
	});

	it('rejects uppercase', () => {
		expect(() => assertValidSlug('PR-1')).toThrow(/Invalid slug/);
	});

	it('rejects path traversal', () => {
		expect(() => assertValidSlug('../../etc')).toThrow(/Invalid slug/);
	});

	it('rejects slashes', () => {
		expect(() => assertValidSlug('foo/bar')).toThrow(/Invalid slug/);
	});

	it('rejects leading hyphen', () => {
		expect(() => assertValidSlug('-bad')).toThrow(/Invalid slug/);
	});

	it('rejects spaces', () => {
		expect(() => assertValidSlug('has space')).toThrow(/Invalid slug/);
	});
});

describe('assertValidIssue', () => {
	it('accepts valid issue numbers', () => {
		expect(() => assertValidIssue('1')).not.toThrow();
		expect(() => assertValidIssue('10')).not.toThrow();
		expect(() => assertValidIssue('9999')).not.toThrow();
	});

	it('accepts zero', () => {
		expect(() => assertValidIssue('0')).not.toThrow();
	});

	it('accepts leading zeros', () => {
		expect(() => assertValidIssue('007')).not.toThrow();
	});

	it('rejects empty string', () => {
		expect(() => assertValidIssue('')).toThrow(/Invalid issue number/);
	});

	it('rejects non-numeric', () => {
		expect(() => assertValidIssue('abc')).toThrow(/Invalid issue number/);
	});

	it('rejects path traversal', () => {
		expect(() => assertValidIssue('../../../etc')).toThrow(/Invalid issue number/);
	});

	it('rejects mixed alphanumeric', () => {
		expect(() => assertValidIssue('10abc')).toThrow(/Invalid issue number/);
	});
});
