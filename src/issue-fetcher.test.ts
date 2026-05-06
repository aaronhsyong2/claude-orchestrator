import { describe, expect, it } from 'vitest';
import {
	type ExecCommandFn,
	extractAgentBrief,
	fetchIssueContent,
	formatIssueContext,
	WORKER_CONSTRAINTS,
} from './issue-fetcher.js';
import type { ExecResult } from './types.js';

describe('extractAgentBrief', () => {
	it('extracts agent brief from comments with ## heading', () => {
		const comments = JSON.stringify([
			{ body: 'Some regular comment' },
			{ body: '## Agent Brief\n\n- **Goal**: Do the thing\n- **Key files**: src/foo.ts' },
		]);
		const result = extractAgentBrief(comments);
		expect(result).toContain('Agent Brief');
		expect(result).toContain('Do the thing');
	});

	it('extracts agent brief with single # heading', () => {
		const comments = JSON.stringify([{ body: '# Agent Brief\n\nSome content here' }]);
		expect(extractAgentBrief(comments)).toContain('Agent Brief');
	});

	it('returns null when no agent brief exists', () => {
		const comments = JSON.stringify([
			{ body: 'Just a regular comment' },
			{ body: 'Another comment without agent brief' },
		]);
		expect(extractAgentBrief(comments)).toBeNull();
	});

	it('returns null for empty comments array', () => {
		expect(extractAgentBrief('[]')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(extractAgentBrief('not json')).toBeNull();
	});

	it('returns null for non-array JSON', () => {
		expect(extractAgentBrief('{"body": "hi"}')).toBeNull();
	});

	it('skips comments without body field', () => {
		const comments = JSON.stringify([{ author: 'someone' }, { body: null }]);
		expect(extractAgentBrief(comments)).toBeNull();
	});
});

describe('fetchIssueContent', () => {
	function makeExec(result: ExecResult): ExecCommandFn {
		return async () => result;
	}

	const successResult: ExecResult = {
		exitCode: 0,
		stdout: JSON.stringify({
			title: 'Pre-fetch issue body',
			body: '## What to build\n\nSome feature spec',
			comments: [{ body: '## Agent Brief\n\n- **Goal**: Build it' }],
		}),
		stderr: '',
	};

	it('returns parsed issue content on success', async () => {
		const result = await fetchIssueContent(46, 'org/repo', '/tmp', makeExec(successResult));
		expect(result).toEqual({
			title: 'Pre-fetch issue body',
			body: '## What to build\n\nSome feature spec',
			agentBrief: '## Agent Brief\n\n- **Goal**: Build it',
		});
	});

	it('passes correct args to execCommand', async () => {
		let capturedArgs: { cmd: string; args: readonly string[]; cwd: string } | null = null;
		const exec: ExecCommandFn = async (cmd, args, cwd) => {
			capturedArgs = { cmd, args, cwd };
			return successResult;
		};

		await fetchIssueContent(46, 'owner/repo', '/worktree', exec);
		expect(capturedArgs).toEqual({
			cmd: 'gh',
			args: ['issue', 'view', '46', '--repo', 'owner/repo', '--json', 'title,body,comments'],
			cwd: '/worktree',
		});
	});

	it('returns null on non-zero exit code', async () => {
		const result = await fetchIssueContent(
			46,
			'org/repo',
			'/tmp',
			makeExec({ exitCode: 1, stdout: '', stderr: 'not found' }),
		);
		expect(result).toBeNull();
	});

	it('returns null when execCommand throws', async () => {
		const exec: ExecCommandFn = async () => {
			throw new Error('network error');
		};
		const result = await fetchIssueContent(46, 'org/repo', '/tmp', exec);
		expect(result).toBeNull();
	});

	it('returns null on invalid JSON stdout', async () => {
		const result = await fetchIssueContent(
			46,
			'org/repo',
			'/tmp',
			makeExec({ exitCode: 0, stdout: 'not json', stderr: '' }),
		);
		expect(result).toBeNull();
	});

	it('returns empty strings for missing title/body', async () => {
		const result = await fetchIssueContent(
			46,
			'org/repo',
			'/tmp',
			makeExec({ exitCode: 0, stdout: '{}', stderr: '' }),
		);
		expect(result).toEqual({ title: '', body: '', agentBrief: null });
	});

	it('returns null agentBrief when no agent brief comment', async () => {
		const result = await fetchIssueContent(
			46,
			'org/repo',
			'/tmp',
			makeExec({
				exitCode: 0,
				stdout: JSON.stringify({
					title: 'Title',
					body: 'Body',
					comments: [{ body: 'regular comment' }],
				}),
				stderr: '',
			}),
		);
		expect(result?.agentBrief).toBeNull();
	});
});

describe('formatIssueContext', () => {
	it('formats issue content with agent brief', () => {
		const result = formatIssueContext({
			title: 'My Issue',
			body: 'Some body text',
			agentBrief: '## Agent Brief\n\n- Goal: do it',
		});
		expect(result).toContain('## Issue: My Issue');
		expect(result).toContain('Some body text');
		expect(result).toContain('---');
		expect(result).toContain('## Agent Brief');
	});

	it('formats issue content without agent brief', () => {
		const result = formatIssueContext({
			title: 'My Issue',
			body: 'Body only',
			agentBrief: null,
		});
		expect(result).toContain('## Issue: My Issue');
		expect(result).toContain('Body only');
		expect(result).not.toContain('---');
	});
});

describe('WORKER_CONSTRAINTS', () => {
	it('contains non-interactive mode notice', () => {
		expect(WORKER_CONSTRAINTS).toContain('non-interactive mode');
	});

	it('contains MCP unavailable notice', () => {
		expect(WORKER_CONSTRAINTS).toContain('MCP tools are unavailable');
	});

	it('contains gh CLI instruction', () => {
		expect(WORKER_CONSTRAINTS).toContain('`gh` CLI for GitHub operations');
	});

	it('contains no-cd constraint', () => {
		expect(WORKER_CONSTRAINTS).toContain('do not `cd` elsewhere');
	});
});
