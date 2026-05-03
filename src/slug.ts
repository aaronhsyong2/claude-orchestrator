const BRANCH_SLUG_RE = /[^a-z0-9-]/g;

/** Only allow safe characters in branch names to prevent git argument injection. */
export const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

/** Validates a branch name for safety without transforming it. Throws on invalid input. */
export function validateBranchName(name: string, label = 'Branch'): void {
	if (!name) {
		throw new Error(`${label} name must not be empty`);
	}
	if (name.startsWith('-')) {
		throw new Error(`Invalid ${label.toLowerCase()} name "${name}" — must not start with a hyphen`);
	}
	if (!SAFE_BRANCH_RE.test(name)) {
		throw new Error(`Invalid ${label.toLowerCase()} name "${name}" — contains unsafe characters`);
	}
	if (/\.\./.test(name)) {
		throw new Error(`Invalid ${label.toLowerCase()} name "${name}" — must not contain consecutive dots`);
	}
}

/**
 * Derives a deterministic filesystem-safe slug from a branch name.
 *
 * NOTE: Distinct branch names can collide to the same slug (e.g. `feat/my-branch`
 * and `feat-my-branch` both become `feat-my-branch`).
 */
export function deriveSlug(branch: string): string {
	validateBranchName(branch, 'Branch');
	const slug = branch
		.toLowerCase()
		.replace(BRANCH_SLUG_RE, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) {
		throw new Error(`Branch "${branch}" produces an empty slug`);
	}
	return slug;
}
