import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sessionPath(groupSlug: string, issue: string, baseDir?: string): string {
	return path.resolve(baseDir ?? '.', '.orchestrator', 'sessions', groupSlug, `${issue}.json`);
}

export function getSessionId(groupSlug: string, issue: string, baseDir?: string): string | null {
	const filePath = sessionPath(groupSlug, issue, baseDir);
	if (!fs.existsSync(filePath)) return null;
	try {
		const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		return typeof data.session_id === 'string' ? data.session_id : null;
	} catch {
		return null;
	}
}

export function createSession(groupSlug: string, issue: string, baseDir?: string): string {
	// Idempotent: return existing session if already created for this issue
	const existing = getSessionId(groupSlug, issue, baseDir);
	if (existing) return existing;

	const filePath = sessionPath(groupSlug, issue, baseDir);
	const sessionId = crypto.randomUUID();
	const now = new Date().toISOString();

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		JSON.stringify(
			{
				session_id: sessionId,
				created: now,
			},
			null,
			2,
		),
	);

	return sessionId;
}
