import { spawn } from 'node:child_process';
import type { TakeoverRequest } from './types.js';

export function spawnTakeover(request: TakeoverRequest): Promise<number> {
	return new Promise((resolve, reject) => {
		const { mode, worktreePath } = request;

		let command: string;
		let args: string[];

		if (mode === 'shell') {
			const shell = process.env.SHELL;
			command = shell?.startsWith('/') ? shell : '/bin/sh';
			args = [];
		} else {
			command = 'nvim';
			args = [worktreePath];
		}

		const proc = spawn(command, args, {
			cwd: worktreePath,
			stdio: 'inherit',
			env: process.env,
		});

		proc.on('error', (err) => {
			reject(new Error(`Failed to spawn ${mode}: ${err.message}`));
		});

		proc.on('close', (code, signal) => {
			if (code !== null) {
				resolve(code);
			} else {
				reject(new Error(`${mode} process killed by signal ${signal ?? 'unknown'}`));
			}
		});
	});
}
