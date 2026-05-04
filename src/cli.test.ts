import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSX_PATH = path.resolve(__dirname, '../node_modules/.bin/tsx');
const CLI_PATH = path.resolve(__dirname, 'cli.tsx');
let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync(TSX_PATH, [CLI_PATH, ...args], {
			cwd: tmpDir,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return { stdout, stderr: '', exitCode: 0 };
	} catch (error: unknown) {
		if (error instanceof Error && 'status' in error) {
			const execError = error as Error & { stdout: string; stderr: string; status: number };
			return {
				stdout: execError.stdout,
				stderr: execError.stderr,
				exitCode: execError.status,
			};
		}
		return { stdout: '', stderr: String(error), exitCode: 1 };
	}
}

describe('cli', () => {
	describe('no command', () => {
		it('prints usage and exits 1', () => {
			const result = run();
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Usage: orchestrator');
		});
	});

	describe('unknown command', () => {
		it('prints usage and exits 1', () => {
			const result = run('bogus');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Usage: orchestrator');
		});
	});

	describe('init', () => {
		it('creates config file', () => {
			const result = run('init');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Created .orchestrator/config.json');

			const configPath = path.join(tmpDir, '.orchestrator/config.json');
			expect(fs.existsSync(configPath)).toBe(true);

			const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
			expect(config.base_branch).toBe('main');
			expect(config.max_concurrent_agents).toBe(3);
		});
	});

	describe('start', () => {
		it('fails with missing plan argument', () => {
			const result = run('start');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Missing plan file argument');
		});

		it('fails when plan file does not exist', () => {
			const result = run('start', 'nonexistent.md');
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Plan file not found');
		});

		it('acquires lock and completes with empty plan', () => {
			// Init config so loadConfig succeeds
			run('init');
			const planPath = path.join(tmpDir, 'plan.md');
			fs.writeFileSync(planPath, '# Test Plan\n');

			const result = run('start', 'plan.md');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Acquired lock');
		});

		it('clears runtime state with --fresh', () => {
			// Init config so loadConfig succeeds
			run('init');
			const planPath = path.join(tmpDir, 'plan.md');
			fs.writeFileSync(planPath, '# Test Plan\n');

			// Create runtime dirs
			const base = path.join(tmpDir, '.orchestrator');
			fs.mkdirSync(path.join(base, 'status'), { recursive: true });
			fs.mkdirSync(path.join(base, 'context'), { recursive: true });
			fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
			fs.writeFileSync(path.join(base, 'status', 'test.json'), '{}');

			const result = run('start', '--fresh', 'plan.md');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Cleared');
			expect(fs.existsSync(path.join(base, 'status'))).toBe(false);
		});
	});

	describe('status', () => {
		it('prints "No active work." when no status files', () => {
			const result = run('status');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('No active work.');
		});

		it('prints status entries when files exist', () => {
			const statusDir = path.join(tmpDir, '.orchestrator/status');
			fs.mkdirSync(statusDir, { recursive: true });
			fs.writeFileSync(
				path.join(statusDir, 'pr-auth.json'),
				JSON.stringify({ slug: 'pr-auth', state: 'in_progress', issues_total: 5, issues_done: 2 }),
			);

			const result = run('status');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('pr-auth');
			expect(result.stdout).toContain('in_progress');
			expect(result.stdout).toContain('2/5 issues done');
		});
	});
});
