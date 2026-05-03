import { withFullScreen } from 'fullscreen-ink';
import React from 'react';
import { Dashboard } from './Dashboard.js';

export function launchDashboard(baseDir = '.'): void {
	const app = React.createElement(Dashboard, { baseDir });
	withFullScreen(app).start();
}
