import { describe, expect, it } from 'vitest';
import { buildDependencyGraph } from './graph.js';
import type { PRGroup } from './types.js';

function makeGroup(overrides: Partial<PRGroup> & { pr_number: number }): PRGroup {
	return {
		title: `PR ${overrides.pr_number}`,
		branch: `feat/pr-${overrides.pr_number}`,
		status: 'pending',
		issues: [],
		depends_on: [],
		...overrides,
	};
}

describe('buildDependencyGraph', () => {
	it('builds graph from groups with no dependencies', () => {
		const groups = [
			makeGroup({ pr_number: 1 }),
			makeGroup({ pr_number: 2 }),
			makeGroup({ pr_number: 3 }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order).toEqual([1, 2, 3]);
	});

	it('respects dependency ordering', () => {
		const groups = [
			makeGroup({ pr_number: 1 }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
			makeGroup({ pr_number: 3, depends_on: [2] }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order.indexOf(1)).toBeLessThan(graph.order.indexOf(2));
		expect(graph.order.indexOf(2)).toBeLessThan(graph.order.indexOf(3));
	});

	it('handles diamond dependencies', () => {
		const groups = [
			makeGroup({ pr_number: 1 }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
			makeGroup({ pr_number: 3, depends_on: [1] }),
			makeGroup({ pr_number: 4, depends_on: [2, 3] }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order.indexOf(1)).toBeLessThan(graph.order.indexOf(2));
		expect(graph.order.indexOf(1)).toBeLessThan(graph.order.indexOf(3));
		expect(graph.order.indexOf(2)).toBeLessThan(graph.order.indexOf(4));
		expect(graph.order.indexOf(3)).toBeLessThan(graph.order.indexOf(4));
	});

	it('detects circular dependencies', () => {
		const groups = [
			makeGroup({ pr_number: 1, depends_on: [2] }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
		];
		expect(() => buildDependencyGraph(groups)).toThrow(/Circular dependency/);
	});

	it('excludes done groups from graph', () => {
		const groups = [
			makeGroup({ pr_number: 1, status: 'done' }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order).toEqual([2]);
		expect(graph.adjacency.has(1)).toBe(false);
	});

	it('excludes merged groups from graph', () => {
		const groups = [
			makeGroup({ pr_number: 1, status: 'merged' }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order).toEqual([2]);
	});

	it('treats dependency on done group as satisfied', () => {
		const groups = [
			makeGroup({ pr_number: 1, status: 'done' }),
			makeGroup({ pr_number: 2, depends_on: [1] }),
			makeGroup({ pr_number: 3, depends_on: [2] }),
		];
		const graph = buildDependencyGraph(groups);
		// PR 2 has no active deps (PR 1 is done), so it comes first
		expect(graph.order.indexOf(2)).toBeLessThan(graph.order.indexOf(3));
		expect(graph.adjacency.get(2)).toEqual([]);
	});

	it('returns empty graph for empty groups', () => {
		const graph = buildDependencyGraph([]);
		expect(graph.order).toEqual([]);
		expect(graph.adjacency.size).toBe(0);
	});

	it('returns empty graph when all groups are done', () => {
		const groups = [
			makeGroup({ pr_number: 1, status: 'done' }),
			makeGroup({ pr_number: 2, status: 'merged' }),
		];
		const graph = buildDependencyGraph(groups);
		expect(graph.order).toEqual([]);
	});
});
