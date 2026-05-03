import type {
	FindingSeverity,
	NdjsonResultMessage,
	WorkerCapableDeps,
	WorkerEvent,
} from './types.js';

export const VALID_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
	'critical',
	'high',
	'medium',
	'low',
]);

export function isBlocking(severity: string): boolean {
	return severity === 'critical' || severity === 'high';
}

// --- Spawn helpers ---

export interface SpawnCaptureResult {
	readonly exitCode: number;
	readonly resultText: string | null;
}

export function spawnAndCapture(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	prompt: string,
	deps: Pick<WorkerCapableDeps, 'spawnWorker'>,
): Promise<SpawnCaptureResult> {
	return new Promise<SpawnCaptureResult>((resolve, reject) => {
		let resultText: string | null = null;
		try {
			deps.spawnWorker(
				issue,
				groupSlug,
				worktreePath,
				(event: WorkerEvent) => {
					if (event.event === 'message' && event.data.type === 'result') {
						const resultMsg = event.data as NdjsonResultMessage;
						resultText = resultMsg.result;
					}
					if (event.event === 'exited') {
						resolve({ exitCode: event.data, resultText });
					}
					if (event.event === 'error') {
						const errMsg = event.data instanceof Error ? event.data.message : String(event.data);
						process.stderr.write(`[review-helpers] spawn error: ${errMsg}\n`);
						resolve({ exitCode: 1, resultText: null });
					}
				},
				prompt,
			);
		} catch (err) {
			reject(err);
		}
	});
}

export function spawnAndWaitForExit(
	issue: string,
	groupSlug: string,
	worktreePath: string,
	prompt: string,
	deps: Pick<WorkerCapableDeps, 'spawnWorker'>,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		try {
			deps.spawnWorker(
				issue,
				groupSlug,
				worktreePath,
				(event: WorkerEvent) => {
					if (event.event === 'exited') resolve(event.data);
					if (event.event === 'error') {
						const errMsg = event.data instanceof Error ? event.data.message : String(event.data);
						process.stderr.write(`[review-helpers] spawn error: ${errMsg}\n`);
						resolve(1);
					}
				},
				prompt,
			);
		} catch (err) {
			reject(err);
		}
	});
}

// --- Context helpers ---

export function appendReviewContext(
	deps: Pick<WorkerCapableDeps, 'readContext' | 'writeContext'>,
	groupSlug: string,
	contextKey: string,
	label: string,
	cycle: number,
	detail: string,
): void {
	const existing = deps.readContext(groupSlug, contextKey) ?? '';
	const entry = `## ${label} cycle ${cycle}\n\n${detail}\n`;
	const updated = existing ? `${existing}\n${entry}` : entry;
	deps.writeContext(groupSlug, contextKey, updated);
}

// --- JSON array parsing ---

/**
 * Parse a JSON array from potentially prose-wrapped LLM output.
 * Uses a two-pass candidate strategy: greedy match (priority) then non-greedy fallback.
 * The `validate` predicate filters items to only keep well-formed entries.
 */
export function parseJsonArray<T>(
	output: string,
	validate: (item: unknown) => item is T,
): readonly T[] {
	const candidates: string[] = [...(output.match(/\[[^[]*?\]/g) ?? [])];

	const greedyMatch = output.match(/\[\s*\{[\s\S]*?\}\s*\]/);
	if (greedyMatch) {
		candidates.unshift(greedyMatch[0]);
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}

		if (!Array.isArray(parsed)) continue;

		// Explicit empty array from LLM = "no findings" — short-circuit
		if (parsed.length === 0) return [];

		const items = parsed.filter(validate);
		if (items.length > 0) return items;
	}

	return [];
}

// --- Rules section builder ---

export function buildRulesSection(ruleContents: readonly string[]): string {
	if (ruleContents.length === 0) return '';
	return `\n\n## Rule Files\n\n${ruleContents.map((content, i) => `### Rule file ${i + 1}\n\n${content}`).join('\n\n')}`;
}
