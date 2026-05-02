import { describe, expect, it } from 'vitest';
import { assertValidIssue, assertValidSlug } from './validation.js';

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
