import * as fs from 'node:fs';
import * as path from 'node:path';

export function getLockPath(baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/lock');
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readLock(baseDir?: string): number | null {
	const lockPath = getLockPath(baseDir);
	if (!fs.existsSync(lockPath)) {
		return null;
	}
	const content = fs.readFileSync(lockPath, 'utf-8').trim();
	const pid = Number.parseInt(content, 10);
	return Number.isNaN(pid) ? null : pid;
}

export function isLockStale(baseDir?: string): boolean {
	const pid = readLock(baseDir);
	if (pid === null) {
		return false;
	}
	return !isProcessAlive(pid);
}

function writeLockExclusive(lockPath: string): void {
	const fd = fs.openSync(lockPath, 'ax');
	try {
		fs.writeSync(fd, `${process.pid}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

export function acquireLock(baseDir?: string): void {
	const lockPath = getLockPath(baseDir);
	const dir = path.dirname(lockPath);
	fs.mkdirSync(dir, { recursive: true });

	try {
		writeLockExclusive(lockPath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw err;
		}
		// Lock file exists — check if holder is alive
		const existingPid = readLock(baseDir);
		if (existingPid !== null && isProcessAlive(existingPid)) {
			throw new Error(
				`Another orchestrator is running (PID ${existingPid}). Stop it first or remove ${lockPath}.`,
			);
		}
		// Stale lock — remove and retry
		fs.unlinkSync(lockPath);
		writeLockExclusive(lockPath);
	}
}

export function releaseLock(baseDir?: string): void {
	const lockPath = getLockPath(baseDir);
	if (!fs.existsSync(lockPath)) {
		return;
	}
	const pid = readLock(baseDir);
	if (pid === process.pid) {
		fs.unlinkSync(lockPath);
	}
}

export function installSignalHandlers(onShutdown?: () => void, baseDir?: string): void {
	let shuttingDown = false;

	const signalHandler = () => {
		if (shuttingDown) return; // Prevent re-entrancy (RESEARCH.md pitfall #1)
		shuttingDown = true;
		if (onShutdown) {
			onShutdown();
		} else {
			// Fallback: release lock and exit (backward compat)
			releaseLock(baseDir);
			process.exit(0);
		}
	};

	process.once('SIGINT', signalHandler);
	process.once('SIGTERM', signalHandler);
	// Clean up lock on normal exit (e.g., event loop drains)
	process.once('exit', () => {
		releaseLock(baseDir);
	});
}
