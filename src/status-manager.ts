import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	GitBranchState,
	GroupActivity,
	GroupStatus,
	GroupStep,
	ReconcileCorrection,
} from './types.js';
import { assertValidSlug } from './validation.js';

const VALID_STEPS: readonly GroupStep[] = [
	'idle',
	'cloning',
	'coding',
	'verifying',
	'reviewing',
	'pr-creating',
	'pr-reviewing',
	'awaiting-merge',
];

export function getGroupStatusPath(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/status', `${groupSlug}.json`);
}

export function getContextDir(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/context', groupSlug);
}

function isValidGroupStatus(value: unknown): value is GroupStatus {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.pr_group === 'string' &&
		typeof obj.branch === 'string' &&
		(obj.current_issue === null || typeof obj.current_issue === 'number') &&
		typeof obj.step === 'string' &&
		VALID_STEPS.includes(obj.step as GroupStep) &&
		typeof obj.step_result === 'string' &&
		Array.isArray(obj.issues_completed) &&
		Array.isArray(obj.issues_remaining) &&
		typeof obj.last_updated === 'string'
	);
}

export function readGroupStatus(groupSlug: string, baseDir?: string): GroupStatus | null {
	assertValidSlug(groupSlug);
	const filePath = getGroupStatusPath(groupSlug, baseDir);

	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(content);
		if (isValidGroupStatus(parsed)) {
			return parsed;
		}
		process.stderr.write(`Warning: skipping malformed group status file ${groupSlug}.json\n`);
		return null;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`Warning: skipping invalid group status file ${groupSlug}.json — ${message}\n`,
		);
		return null;
	}
}

export function writeGroupStatus(groupSlug: string, data: GroupStatus, baseDir?: string): void {
	assertValidSlug(groupSlug);
	const filePath = getGroupStatusPath(groupSlug, baseDir);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, '\t')}\n`);
	fs.renameSync(tmpPath, filePath);
}

// --- Activity file CRUD ---

const MAX_RECENT_ACTIONS = 20;

export function getGroupActivityPath(groupSlug: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/status', `${groupSlug}.activity.json`);
}

export function writeGroupActivity(groupSlug: string, data: GroupActivity, baseDir?: string): void {
	assertValidSlug(groupSlug);
	const filePath = getGroupActivityPath(groupSlug, baseDir);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	const capped: GroupActivity = {
		...data,
		recent_actions: data.recent_actions.slice(0, MAX_RECENT_ACTIONS),
	};

	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(capped, null, '\t')}\n`);
	fs.renameSync(tmpPath, filePath);
}

export function readGroupActivity(groupSlug: string, baseDir?: string): GroupActivity | null {
	assertValidSlug(groupSlug);
	const filePath = getGroupActivityPath(groupSlug, baseDir);

	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(content);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as Record<string, unknown>).last_activity === 'string' &&
			Array.isArray((parsed as Record<string, unknown>).recent_actions)
		) {
			return parsed as GroupActivity;
		}
		return null;
	} catch {
		return null;
	}
}

export function appendToolActivity(
	groupSlug: string,
	message: string,
	nowIso: string,
	baseDir?: string,
): void {
	const existing = readGroupActivity(groupSlug, baseDir);
	const recentActions = existing?.recent_actions ?? [];

	writeGroupActivity(
		groupSlug,
		{
			last_activity: nowIso,
			recent_actions: [{ timestamp: nowIso, message }, ...recentActions],
		},
		baseDir,
	);
}

// --- Context file CRUD ---

export function writeContext(
	groupSlug: string,
	issue: string,
	content: string,
	baseDir?: string,
): void {
	assertValidSlug(groupSlug);
	assertValidIssueParam(issue);
	const contextDir = getContextDir(groupSlug, baseDir);
	fs.mkdirSync(contextDir, { recursive: true });
	fs.writeFileSync(path.join(contextDir, `${issue}.md`), content);
}

export function readContext(groupSlug: string, issue: string, baseDir?: string): string | null {
	assertValidSlug(groupSlug);
	assertValidIssueParam(issue);
	const filePath = path.join(getContextDir(groupSlug, baseDir), `${issue}.md`);

	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`Warning: failed to read context file ${filePath}: ${message}\n`);
		return null;
	}
}

export function deleteContext(groupSlug: string, issue: string, baseDir?: string): void {
	assertValidSlug(groupSlug);
	assertValidIssueParam(issue);
	const filePath = path.join(getContextDir(groupSlug, baseDir), `${issue}.md`);

	try {
		fs.unlinkSync(filePath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}

// Context issue params use a different format than worker-manager issues (e.g. "issue-10")
// so we validate they contain no path traversal characters rather than requiring pure digits.
const CONTEXT_ISSUE_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertValidIssueParam(issue: string): void {
	if (!CONTEXT_ISSUE_RE.test(issue)) {
		throw new Error(
			`Invalid issue identifier "${issue}" — must be lowercase alphanumeric with hyphens`,
		);
	}
}

// --- Reconcile ---

export function reconcile(
	gitState: GitBranchState,
	baseDir?: string,
	now: () => string = () => new Date().toISOString(),
): readonly ReconcileCorrection[] {
	const statusDir = path.resolve(baseDir ?? '.', '.orchestrator/status');

	if (!fs.existsSync(statusDir)) {
		return [];
	}

	const files = fs
		.readdirSync(statusDir)
		.filter((f) => f.endsWith('.json') && !f.endsWith('.activity.json'));
	const corrections: ReconcileCorrection[] = [];
	const branchSet = new Set(gitState.branches);

	for (const file of files) {
		let parsed: GroupStatus;
		try {
			const content = fs.readFileSync(path.join(statusDir, file), 'utf-8');
			const raw: unknown = JSON.parse(content);
			if (!isValidGroupStatus(raw)) continue;
			parsed = raw;
		} catch {
			// Skip unreadable/unparseable files — not actionable
			continue;
		}

		const slug = file.replace(/\.json$/, '');

		if (!branchSet.has(parsed.branch)) {
			const corrected: GroupStatus = {
				...parsed,
				step: 'idle',
				current_issue: null,
				step_result: '',
				last_updated: now(),
			};
			writeGroupStatus(slug, corrected, baseDir);
			corrections.push({ slug, reason: `branch "${parsed.branch}" no longer exists` });
			continue;
		}

		const hasCommits = gitState.branchHasCommits.get(parsed.branch);
		if (hasCommits === false && parsed.step !== 'idle') {
			const corrected: GroupStatus = {
				...parsed,
				step: 'idle',
				current_issue: null,
				step_result: '',
				last_updated: now(),
			};
			writeGroupStatus(slug, corrected, baseDir);
			corrections.push({ slug, reason: `branch "${parsed.branch}" has no commits` });
		}
	}

	return corrections;
}
