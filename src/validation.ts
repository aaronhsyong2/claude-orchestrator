const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ISSUE_RE = /^\d+$/;

export function assertValidSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) {
		throw new Error(`Invalid slug "${slug}" — must be lowercase alphanumeric with hyphens`);
	}
}

export function assertValidIssue(issue: string): void {
	if (!ISSUE_RE.test(issue)) {
		throw new Error(`Invalid issue number "${issue}" — must be numeric`);
	}
}
