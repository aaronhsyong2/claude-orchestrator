import { useEffect, useRef } from 'react';
import type { GroupStatus, NotificationConfig } from '../types.js';
import { notify } from './notification-service.js';

// Known step_result values — kept in sync with scheduler.ts
const RESULT_NEEDS_INPUT = 'needs-input';
const RESULT_WORKTREE_ERROR_PREFIX = 'worktree error';
const RESULT_WORKER_ERROR_PREFIX = 'worker error';
const RESULT_READY_FOR_REVIEW = 'ready for self-review';

interface TransitionNotification {
	readonly message: string;
}

export function detectTransition(group: GroupStatus): TransitionNotification | null {
	if (group.step_result === RESULT_NEEDS_INPUT) {
		return { message: `${group.pr_group}: needs input` };
	}
	if (
		group.step_result.startsWith(RESULT_WORKTREE_ERROR_PREFIX) ||
		group.step_result.startsWith(RESULT_WORKER_ERROR_PREFIX)
	) {
		return { message: `${group.pr_group}: ${group.step_result}` };
	}
	if (group.step === 'reviewing' && group.step_result === RESULT_READY_FOR_REVIEW) {
		return { message: `${group.pr_group}: review cycle complete` };
	}
	return null;
}

export function useNotifications(groups: readonly GroupStatus[], config: NotificationConfig): void {
	const prevResultsRef = useRef<ReadonlyMap<string, string>>(new Map());
	const initializedRef = useRef(false);

	useEffect(() => {
		const prev = prevResultsRef.current;
		const next = new Map<string, string>();

		for (const group of groups) {
			next.set(group.pr_group, group.step_result);

			if (initializedRef.current) {
				const oldResult = prev.get(group.pr_group);
				if (oldResult === group.step_result) continue;

				const notification = detectTransition(group);
				if (notification) {
					notify(notification.message, config).catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						process.stderr.write(`[notification] dispatch failed: ${msg}\n`);
					});
				}
			}
		}

		prevResultsRef.current = next;
		initializedRef.current = true;
	}, [groups, config]);
}
