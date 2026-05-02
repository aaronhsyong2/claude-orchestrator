const BRANCH_SLUG_RE = /[^a-z0-9-]/g;

/**
 * Derives a deterministic filesystem-safe slug from a branch name.
 *
 * NOTE: Distinct branch names can collide to the same slug (e.g. `feat/my-branch`
 * and `feat-my-branch` both become `feat-my-branch`).
 */
export function deriveSlug(branch: string): string {
	if (!branch) {
		throw new Error('Branch name must not be empty');
	}
	if (branch.startsWith('-')) {
		throw new Error(`Invalid branch name "${branch}" — must not start with a hyphen`);
	}
	const slug = branch
		.toLowerCase()
		.replace(BRANCH_SLUG_RE, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) {
		throw new Error(`Branch "${branch}" produces an empty slug`);
	}
	return slug;
}
