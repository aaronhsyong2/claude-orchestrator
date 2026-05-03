import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { NotificationConfig } from '../types.js';
import type { NotificationLevel } from './types.js';

const execFile = promisify(execFileCb);

export async function sendSystemNotification(message: string): Promise<boolean> {
	try {
		const escaped = message.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
		await execFile('osascript', [
			'-e',
			`display notification "${escaped}" with title "Orchestrator"`,
		]);
		return true;
	} catch (err) {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		process.stderr.write(`[notification] osascript failed: ${detail}\n`);
		return false;
	}
}

export async function notify(
	message: string,
	_level: NotificationLevel,
	config: NotificationConfig,
): Promise<void> {
	if (config.system) {
		await sendSystemNotification(message);
	}
}
