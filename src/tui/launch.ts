import { render } from 'ink';
import React from 'react';
import { Dashboard } from './Dashboard.js';
import { spawnTakeover } from './takeover.js';
import type { DashboardState, TakeoverRequest } from './types.js';

const ALT_BUFFER_ENTER = '\x1b[?1049h';
const ALT_BUFFER_EXIT = '\x1b[?1049l';

function write(content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(content, (err) => (err ? reject(err) : resolve()));
	});
}

export async function launchDashboard(baseDir = '.'): Promise<void> {
	let savedState: DashboardState | undefined;

	for (;;) {
		await write(ALT_BUFFER_ENTER);

		let inkInstance: ReturnType<typeof render> | undefined;

		const request = await new Promise<TakeoverRequest | null>((resolveTakeover) => {
			const onTakeover = (req: TakeoverRequest, state: DashboardState) => {
				savedState = state;
				inkInstance?.unmount();
				resolveTakeover(req);
			};

			const onQuit = () => {
				inkInstance?.unmount();
				resolveTakeover(null);
			};

			const app = React.createElement(Dashboard, {
				baseDir,
				initialState: savedState,
				onTakeover,
				onQuit,
			});

			inkInstance = render(app);
		});

		await write(ALT_BUFFER_EXIT);

		if (!request) break;

		await spawnTakeover(request);
	}
}
