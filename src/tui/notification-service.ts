import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { NotificationConfig } from '../types.js';

const execFile = promisify(execFileCb);

export async function sendSystemNotification(message: string): Promise<boolean> {
	try {
		await execFile('osascript', [
			'-e',
			'on run argv\ndisplay notification (item 1 of argv) with title "Orchestrator"\nend run',
			'--',
			message,
		]);
		return true;
	} catch (err) {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		process.stderr.write(`[notification] osascript failed: ${detail}\n`);
		return false;
	}
}

export async function notify(message: string, config: NotificationConfig): Promise<void> {
	if (config.system) {
		await sendSystemNotification(message);
	}
}
