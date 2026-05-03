import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { OrchestratorConfig } from './types.js';

export const DEFAULT_CONFIG: OrchestratorConfig = {
	base_branch: 'main',
	max_concurrent_agents: 3,
	max_retries_on_fail: 2,
	max_review_cycles: 3,
	verify: [
		{ name: 'lint', command: 'pnpm run check' },
		{ name: 'typecheck', command: 'pnpm run typecheck' },
		{ name: 'build', command: 'pnpm run build' },
		{ name: 'test', command: 'pnpm run test -- --run' },
		{ name: 'e2e', command: 'pnpm run test:e2e' },
	],
	rule_files: ['CLAUDE.md', '.claude/rules/**/*.md', 'docs/decisions/*.md'],
	issue_source: {
		type: 'github',
		repo: 'org/repo-name',
	},
	notifications: {
		system: true,
	},
};

export function getConfigPath(baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator/config.json');
}

export function configExists(baseDir?: string): boolean {
	return fs.existsSync(getConfigPath(baseDir));
}

export function writeDefaultConfig(baseDir?: string, force = false): boolean {
	const configPath = getConfigPath(baseDir);

	if (fs.existsSync(configPath) && !force) {
		return false;
	}

	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, '\t')}\n`);
	return true;
}

export function validateConfig(value: unknown): value is OrchestratorConfig {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.base_branch === 'string' &&
		typeof obj.max_concurrent_agents === 'number' &&
		obj.max_concurrent_agents >= 1 &&
		obj.max_concurrent_agents <= 20 &&
		typeof obj.max_retries_on_fail === 'number' &&
		typeof obj.max_review_cycles === 'number' &&
		Array.isArray(obj.verify) &&
		Array.isArray(obj.rule_files) &&
		typeof obj.issue_source === 'object' &&
		obj.issue_source !== null &&
		typeof obj.notifications === 'object' &&
		obj.notifications !== null
	);
}

export function loadConfig(baseDir?: string): OrchestratorConfig {
	const configPath = getConfigPath(baseDir);
	let content: string;
	try {
		content = fs.readFileSync(configPath, 'utf-8');
	} catch {
		throw new Error(`Failed to read config at ${configPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in config at ${configPath}`);
	}
	if (!validateConfig(parsed)) {
		throw new Error(`Invalid config shape in ${configPath} — missing required fields`);
	}
	return parsed;
}

export function promptOverwrite(): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question('.orchestrator/config.json already exists. Overwrite? [y/N] ', (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === 'y');
		});
	});
}
