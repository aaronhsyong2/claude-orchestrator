import * as fs from 'node:fs';
import * as path from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { readGroupActivity, readGroupStatus } from '../status-manager.js';
import type { GroupActivity, GroupStatus } from '../types.js';
import { formatStepLabel, trackStepStarts } from './observability.js';
import type { ActivityEvent } from './types.js';

const STALE_THRESHOLD_MS = 90_000;

async function listGroupSlugs(baseDir: string): Promise<readonly string[]> {
	const statusDir = path.resolve(baseDir, '.orchestrator/status');
	try {
		const entries = await fs.promises.readdir(statusDir);
		return entries
			.filter((f) => f.endsWith('.json') && !f.endsWith('.activity.json'))
			.map((f) => f.replace(/\.json$/, ''));
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
}

export interface DeriveActivityResult {
	readonly events: readonly ActivityEvent[];
	readonly nextId: number;
}

export function deriveActivity(
	prev: readonly GroupStatus[],
	next: readonly GroupStatus[],
	now: string,
	startId: number,
): DeriveActivityResult {
	const prevMap = new Map(prev.map((g) => [g.pr_group, g]));
	const events: ActivityEvent[] = [];
	let nextId = startId;

	for (const group of next) {
		const old = prevMap.get(group.pr_group);
		if (!old) {
			events.push({ id: nextId++, timestamp: now, message: `${group.pr_group} appeared` });
			continue;
		}
		if (old.step !== group.step) {
			const issue = group.current_issue ? `#${group.current_issue}` : group.pr_group;
			events.push({ id: nextId++, timestamp: now, message: `${issue} ${group.step}` });
		}
	}

	return { events, nextId };
}

export interface StatusPollerResult {
	readonly groups: readonly GroupStatus[];
	readonly activity: readonly ActivityEvent[];
	readonly stepLabels: ReadonlyMap<string, string>;
}

export function useStatusPoller(baseDir: string, intervalMs = 2000): StatusPollerResult {
	const [groups, setGroups] = useState<readonly GroupStatus[]>([]);
	const [activity, setActivity] = useState<readonly ActivityEvent[]>([]);
	const [stepLabels, setStepLabels] = useState<ReadonlyMap<string, string>>(new Map());
	const prevGroupsRef = useRef<readonly GroupStatus[]>([]);
	const stepStartTimesRef = useRef<ReadonlyMap<string, string>>(new Map());
	const prevToolActionsRef = useRef<ReadonlySet<string>>(new Set());
	const nextIdRef = useRef(1);

	useEffect(() => {
		async function poll() {
			try {
				const slugs = await listGroupSlugs(baseDir);
				const entries: GroupStatus[] = [];
				const lastActivityMap = new Map<string, string>();
				const activityCache = new Map<string, GroupActivity | null>();

				for (const slug of slugs) {
					try {
						const status = readGroupStatus(slug, baseDir);
						if (status) entries.push(status);
					} catch (slugErr: unknown) {
						const detail = slugErr instanceof Error ? slugErr.message : String(slugErr);
						process.stderr.write(`[status-poller] skipping ${slug}: ${detail}\n`);
					}

					try {
						const groupActivity = readGroupActivity(slug, baseDir);
						activityCache.set(slug, groupActivity);
						if (groupActivity?.last_activity) {
							lastActivityMap.set(slug, groupActivity.last_activity);
						}
					} catch {
						activityCache.set(slug, null);
					}
				}

				const nowIso = new Date().toISOString();
				const now = nowIso.slice(11, 16);
				const result = deriveActivity(prevGroupsRef.current, entries, now, nextIdRef.current);
				nextIdRef.current = result.nextId;

				// Collect new tool actions from cached activity reads
				const toolEvents: ActivityEvent[] = [];
				const newSeenKeys = new Set<string>();
				for (const slug of slugs) {
					const groupActivity = activityCache.get(slug);
					if (groupActivity) {
						for (const action of groupActivity.recent_actions) {
							if (!action.timestamp || !action.message) continue;
							const key = `${slug}:${action.timestamp}:${action.message}`;
							newSeenKeys.add(key);
							if (!prevToolActionsRef.current.has(key)) {
								toolEvents.push({
									id: nextIdRef.current++,
									timestamp: action.timestamp.slice(11, 16),
									message: action.message,
								});
							}
						}
					}
				}
				prevToolActionsRef.current = newSeenKeys;

				const newStepStarts = trackStepStarts(
					stepStartTimesRef.current,
					entries,
					nowIso,
					prevGroupsRef.current,
				);
				stepStartTimesRef.current = newStepStarts;

				const labels = new Map<string, string>();
				for (const group of entries) {
					labels.set(
						group.pr_group,
						formatStepLabel(
							group.step,
							newStepStarts.get(group.pr_group) ?? null,
							lastActivityMap.get(group.pr_group) ?? null,
							nowIso,
							STALE_THRESHOLD_MS,
						),
					);
				}
				setStepLabels(labels);

				prevGroupsRef.current = entries;
				setGroups(entries);

				const allNewEvents = [...toolEvents, ...result.events];
				if (allNewEvents.length > 0) {
					setActivity((prev) => [...allNewEvents, ...prev].slice(0, 50));
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[status-poller] poll failed: ${msg}\n`);
			}
		}

		void poll();
		const timer = setInterval(() => void poll(), intervalMs);
		return () => clearInterval(timer);
	}, [baseDir, intervalMs]);

	return { groups, activity, stepLabels };
}
