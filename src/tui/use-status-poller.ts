import * as fs from 'node:fs';
import * as path from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { readGroupStatus } from '../status-manager.js';
import type { GroupStatus } from '../types.js';
import type { ActivityEvent } from './types.js';

async function listGroupSlugs(baseDir: string): Promise<readonly string[]> {
	const statusDir = path.resolve(baseDir, '.orchestrator/status');
	try {
		const entries = await fs.promises.readdir(statusDir);
		return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
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
}

export function useStatusPoller(baseDir: string, intervalMs = 2000): StatusPollerResult {
	const [groups, setGroups] = useState<readonly GroupStatus[]>([]);
	const [activity, setActivity] = useState<readonly ActivityEvent[]>([]);
	const prevGroupsRef = useRef<readonly GroupStatus[]>([]);
	const nextIdRef = useRef(1);

	useEffect(() => {
		async function poll() {
			try {
				const slugs = await listGroupSlugs(baseDir);
				const entries: GroupStatus[] = [];

				for (const slug of slugs) {
					const status = readGroupStatus(slug, baseDir);
					if (status) entries.push(status);
				}

				const now = new Date().toISOString().slice(11, 16);
				const result = deriveActivity(prevGroupsRef.current, entries, now, nextIdRef.current);
				nextIdRef.current = result.nextId;

				prevGroupsRef.current = entries;
				setGroups(entries);

				if (result.events.length > 0) {
					setActivity((prev) => [...result.events, ...prev].slice(0, 50));
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

	return { groups, activity };
}
