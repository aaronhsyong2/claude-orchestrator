import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShutdownMode, ShutdownSignal } from './types.js';

export interface WorkerRegistry {
	readonly register: (pid: number) => void;
	readonly deregister: (pid: number) => void;
	readonly getActivePids: () => readonly number[];
}

export function getShutdownPath(baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/shutdown');
}

export function writeShutdownFile(mode: ShutdownMode, baseDir?: string): void {
	const filePath = getShutdownPath(baseDir);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	const signal: ShutdownSignal = {
		mode,
		requested_at: new Date().toISOString(),
	};

	// Atomic write via tmp+rename (same pattern as status-manager.ts:72-74)
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(signal, null, '\t')}\n`);
	fs.renameSync(tmpPath, filePath);
}

export function readShutdownFile(baseDir?: string): ShutdownSignal | null {
	const filePath = getShutdownPath(baseDir);
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (parsed.mode === 'graceful' || parsed.mode === 'force') {
			return {
				mode: parsed.mode as ShutdownMode,
				requested_at: String(parsed.requested_at ?? ''),
			};
		}
		return null;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		process.stderr.write(`[shutdown] failed to read shutdown file: ${String(err)}\n`);
		return null;
	}
}

export function clearShutdownFile(baseDir?: string): void {
	try {
		fs.unlinkSync(getShutdownPath(baseDir));
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}

export function createWorkerRegistry(): WorkerRegistry {
	const pids = new Set<number>();

	return {
		register: (pid: number): void => {
			pids.add(pid);
		},
		deregister: (pid: number): void => {
			pids.delete(pid);
		},
		getActivePids: (): readonly number[] => Array.from(pids),
	};
}

export async function forceKillAll(
	registry: WorkerRegistry,
	killWorker: (pid: number) => Promise<void>,
): Promise<void> {
	await Promise.allSettled(registry.getActivePids().map((pid) => killWorker(pid)));
}
