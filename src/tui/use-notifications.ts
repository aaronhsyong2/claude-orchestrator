import { useEffect, useRef } from 'react';
import type { GroupStatus, NotificationConfig } from '../types.js';
import { notify } from './notification-service.js';
import type { NotificationLevel } from './types.js';

interface TransitionNotification {
	readonly message: string;
	readonly level: NotificationLevel;
}

function detectTransition(group: GroupStatus): TransitionNotification | null {
	if (group.step_result === 'needs-input') {
		return { message: `${group.pr_group}: needs input`, level: 'warning' };
	}
	if (
		group.step_result.startsWith('worktree error') ||
		group.step_result.startsWith('worker error')
	) {
		return { message: `${group.pr_group}: ${group.step_result}`, level: 'error' };
	}
	if (group.step === 'reviewing' && group.step_result === 'ready for self-review') {
		return { message: `${group.pr_group}: review cycle complete`, level: 'info' };
	}
	return null;
}

export function useNotifications(groups: readonly GroupStatus[], config: NotificationConfig): void {
	const prevResultsRef = useRef<ReadonlyMap<string, string>>(new Map());

	useEffect(() => {
		const prev = prevResultsRef.current;
		const next = new Map<string, string>();

		for (const group of groups) {
			next.set(group.pr_group, group.step_result);

			const oldResult = prev.get(group.pr_group);
			if (oldResult === group.step_result) continue;

			const notification = detectTransition(group);
			if (notification) {
				void notify(notification.message, notification.level, config);
			}
		}

		prevResultsRef.current = next;
	}, [groups, config]);
}
