#!/usr/bin/env node
import { Box, render, Text } from 'ink';

function App() {
	return (
		<Box padding={1}>
			<Text color="green" bold>
				orchestrator
			</Text>
		</Box>
	);
}

render(<App />);
