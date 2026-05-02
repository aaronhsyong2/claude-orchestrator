import * as fs from 'node:fs';
import * as path from 'node:path';

const RUNTIME_DIRS = ['status', 'context', 'logs', 'worktrees'] as const;

export function clearRuntimeState(baseDir?: string): void {
	const base = path.resolve(baseDir ?? '.', '.orchestrator');
	for (const dir of RUNTIME_DIRS) {
		fs.rmSync(path.join(base, dir), { recursive: true, force: true });
	}
}
