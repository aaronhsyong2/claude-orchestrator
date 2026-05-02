import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { cli: 'src/cli.tsx' },
	format: ['esm'],
	target: 'es2022',
	shims: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	minify: false,
	outDir: 'dist',
});
