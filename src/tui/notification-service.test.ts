import { describe, expect, it, vi } from 'vitest';
import type { NotificationConfig } from '../types.js';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
	execFile: (...args: unknown[]) => {
		const cb = args[args.length - 1];
		const result = mockExecFile(...args);
		if (typeof cb === 'function') {
			if (result instanceof Error) {
				(cb as (err: Error) => void)(result);
			} else {
				(cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
			}
		}
	},
}));

// Import after mock
const { sendSystemNotification, notify } = await import('./notification-service.js');

describe('sendSystemNotification', () => {
	it('returns true on success', async () => {
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cb = args[args.length - 1];
			if (typeof cb === 'function') return undefined;
			return undefined;
		});
		const result = await sendSystemNotification('test message');
		expect(result).toBe(true);
	});

	it('returns false and logs on failure', async () => {
		mockExecFile.mockImplementation(() => {
			return new Error('osascript not found');
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const result = await sendSystemNotification('test message');
		expect(result).toBe(false);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('[notification] osascript failed'),
		);
		stderrSpy.mockRestore();
	});

	it('escapes double quotes in messages for AppleScript', async () => {
		mockExecFile.mockImplementation(() => undefined);
		const result = await sendSystemNotification('test "quotes" & <brackets>');
		expect(result).toBe(true);
		const args = mockExecFile.mock.calls.at(-1) as unknown[];
		const scriptArgs = args?.[1] as string[];
		expect(scriptArgs[1]).toContain('test \\"quotes\\"');
	});
});

describe('notify', () => {
	it('calls sendSystemNotification when config.system is true', async () => {
		mockExecFile.mockImplementation(() => undefined);
		const config: NotificationConfig = { system: true };
		await notify('test', 'warning', config);
		expect(mockExecFile).toHaveBeenCalled();
	});

	it('does NOT call sendSystemNotification when config.system is false', async () => {
		mockExecFile.mockClear();
		const config: NotificationConfig = { system: false };
		await notify('test', 'warning', config);
		expect(mockExecFile).not.toHaveBeenCalled();
	});
});
