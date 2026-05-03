import * as fs from 'node:fs';
import * as path from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { readGroupStatus } from '../status-manager.js';
import type { GroupStatus } from '../types.js';
import type { ActivityEvent } from './types.js';

function listGroupSlugs(baseDir: string): readonly string[] {
	const statusDir = path.resolve(baseDir, '.orchestrator/status');
	if (!fs.existsSync(statusDir)) return [];

	return fs
		.readdirSync(statusDir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => f.replace(/\.json$/, ''));
}

let nextEventId = 1;

export function deriveActivity(
	prev: readonly GroupStatus[],
	next: readonly GroupStatus[],
	now: string,
): readonly ActivityEvent[] {
	const prevMap = new Map(prev.map((g) => [g.pr_group, g]));
	const events: ActivityEvent[] = [];

	for (const group of next) {
		const old = prevMap.get(group.pr_group);
		if (!old) {
			events.push({ id: nextEventId++, timestamp: now, message: `${group.pr_group} appeared` });
			continue;
		}
		if (old.step !== group.step) {
			const issue = group.current_issue ? `#${group.current_issue}` : group.pr_group;
			events.push({ id: nextEventId++, timestamp: now, message: `${issue} ${group.step}` });
		}
	}

	return events;
}

export interface StatusPollerResult {
	readonly groups: readonly GroupStatus[];
	readonly activity: readonly ActivityEvent[];
}

export function useStatusPoller(baseDir: string, intervalMs = 2000): StatusPollerResult {
	const [groups, setGroups] = useState<readonly GroupStatus[]>([]);
	const [activity, setActivity] = useState<readonly ActivityEvent[]>([]);
	const prevGroupsRef = useRef<readonly GroupStatus[]>([]);

	useEffect(() => {
		function poll() {
			const slugs = listGroupSlugs(baseDir);
			const entries: GroupStatus[] = [];

			for (const slug of slugs) {
				const status = readGroupStatus(slug, baseDir);
				if (status) entries.push(status);
			}

			const now = new Date().toISOString().slice(11, 16);
			const newEvents = deriveActivity(prevGroupsRef.current, entries, now);

			prevGroupsRef.current = entries;
			setGroups(entries);

			if (newEvents.length > 0) {
				setActivity((prev) => [...newEvents, ...prev].slice(0, 50));
			}
		}

		poll();
		const timer = setInterval(poll, intervalMs);
		return () => clearInterval(timer);
	}, [baseDir, intervalMs]);

	return { groups, activity };
}
