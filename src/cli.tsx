#!/usr/bin/env node
import * as fs from 'node:fs';
import { configExists, promptOverwrite, writeDefaultConfig } from './config.js';
import { acquireLock, installSignalHandlers } from './lock.js';
import { clearRuntimeState } from './runtime.js';
import { printStatus } from './status.js';

const USAGE = `Usage: orchestrator <command>

Commands:
  init             Scaffold .orchestrator/config.json with defaults
  start <plan>     Start orchestration from a plan file
  status           Print current orchestration status

Options:
  start --fresh    Clear runtime state before starting
`;

function printUsage(): void {
	process.stderr.write(USAGE);
	process.exit(1);
}

async function handleInit(): Promise<void> {
	if (configExists()) {
		const overwrite = await promptOverwrite();
		if (!overwrite) {
			process.stdout.write('Skipped.\n');
			return;
		}
		writeDefaultConfig(undefined, true);
	} else {
		writeDefaultConfig();
	}
	process.stdout.write('Created .orchestrator/config.json with defaults.\n');
}

function handleStart(args: readonly string[]): void {
	const fresh = args.includes('--fresh');
	const remaining = args.filter((a) => a !== '--fresh');
	const planPath = remaining[0];

	if (!planPath) {
		process.stderr.write('Error: Missing plan file argument.\n');
		process.stderr.write('Usage: orchestrator start [--fresh] <plan>\n');
		process.exit(1);
	}

	if (!fs.existsSync(planPath)) {
		process.stderr.write(`Error: Plan file not found: ${planPath}\n`);
		process.exit(1);
	}

	if (fresh) {
		clearRuntimeState();
		process.stdout.write('Cleared .orchestrator/status/, context/, logs/\n');
	}

	acquireLock();
	installSignalHandlers();
	process.stdout.write(`Acquired lock (.orchestrator/lock, PID ${process.pid})\n`);
	// Lock held until process exits or scheduler (#9) releases it.
	// Signal handlers clean up lock on SIGINT/SIGTERM.
	process.stdout.write('Orchestrator started. Scheduler not yet implemented (see Issue #9).\n');
}

function handleStatus(): void {
	printStatus();
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	switch (command) {
		case 'init':
			await handleInit();
			break;
		case 'start':
			handleStart(args.slice(1));
			break;
		case 'status':
			handleStatus();
			break;
		default:
			printUsage();
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
});
