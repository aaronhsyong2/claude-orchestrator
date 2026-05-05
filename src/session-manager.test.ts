import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, getSessionId } from './session-manager';

describe('session-manager', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-session-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('getSessionId', () => {
		it('returns null for non-existent session', () => {
			const result = getSessionId('group-1', '43', tmpDir);
			expect(result).toBeNull();
		});

		it('returns null for corrupt JSON file', () => {
			const filePath = path.join(tmpDir, '.orchestrator', 'sessions', 'g', '1.json');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, 'not valid json{{{');
			expect(getSessionId('g', '1', tmpDir)).toBeNull();
		});

		it('returns null when session_id is not a string', () => {
			const filePath = path.join(tmpDir, '.orchestrator', 'sessions', 'g', '2.json');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify({ session_id: 42 }));
			expect(getSessionId('g', '2', tmpDir)).toBeNull();
		});
	});

	describe('roundtrip', () => {
		it('getSessionId retrieves previously created session', () => {
			const sessionId = createSession('pr-batch', '43', tmpDir);
			const retrieved = getSessionId('pr-batch', '43', tmpDir);
			expect(retrieved).toBe(sessionId);
		});
	});

	describe('createSession', () => {
		it('returns same sessionId on repeated calls (idempotent)', () => {
			const first = createSession('pr-batch', '10', tmpDir);
			const second = createSession('pr-batch', '10', tmpDir);
			expect(second).toBe(first);
		});

		it('creates nested directories for deep group slugs', () => {
			const sessionId = createSession('deeply/nested/group', '99', tmpDir);
			expect(sessionId).toBeDefined();
			const retrieved = getSessionId('deeply/nested/group', '99', tmpDir);
			expect(retrieved).toBe(sessionId);
		});

		it('returns valid UUID and persists to disk', () => {
			const sessionId = createSession('group-1', '43', tmpDir);

			// Returns valid UUID v4
			expect(sessionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);

			// Persists to expected path
			const filePath = path.join(tmpDir, '.orchestrator', 'sessions', 'group-1', '43.json');
			expect(fs.existsSync(filePath)).toBe(true);

			// File contains correct structure
			const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			expect(data.session_id).toBe(sessionId);
			expect(data.created).toBeDefined();
		});
	});
});
