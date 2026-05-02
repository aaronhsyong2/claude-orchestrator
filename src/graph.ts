import type { DependencyGraph, PRGroup } from './types.js';

export function buildDependencyGraph(groups: readonly PRGroup[]): DependencyGraph {
	const activeGroups = groups.filter((g) => g.status !== 'done' && g.status !== 'merged');
	const activeNumbers = new Set(activeGroups.map((g) => g.pr_number));

	// Build adjacency: node → nodes it depends on (that are still active)
	const adjacency = new Map<number, readonly number[]>();
	for (const group of activeGroups) {
		const activeDeps = group.depends_on.filter((dep) => activeNumbers.has(dep));
		adjacency.set(group.pr_number, activeDeps);
	}

	const order = topologicalSort(adjacency, activeNumbers);

	return { adjacency, order };
}

function topologicalSort(
	adjacency: ReadonlyMap<number, readonly number[]>,
	nodes: ReadonlySet<number>,
): readonly number[] {
	// Kahn's algorithm — BFS-based
	// adjacency: node → deps it depends on. Reverse to: dep → dependents.

	const inDegree = new Map<number, number>();
	const dependents = new Map<number, readonly number[]>();
	for (const node of nodes) {
		inDegree.set(node, 0);
		dependents.set(node, []);
	}

	for (const [node, deps] of adjacency) {
		inDegree.set(node, deps.length);
		for (const dep of deps) {
			dependents.set(dep, [...(dependents.get(dep) ?? []), node]);
		}
	}

	// Seed queue with nodes that have no active dependencies (sorted for determinism)
	const queue = [...nodes].filter((n) => inDegree.get(n) === 0).sort((a, b) => a - b);

	const result: number[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		result.push(current);

		for (const dependent of dependents.get(current) ?? []) {
			const newDegree = (inDegree.get(dependent) ?? 0) - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) {
				// Binary search for sorted insert (deterministic output)
				let lo = 0;
				let hi = queue.length;
				while (lo < hi) {
					const mid = (lo + hi) >>> 1;
					if (queue[mid] < dependent) lo = mid + 1;
					else hi = mid;
				}
				queue.splice(lo, 0, dependent);
			}
		}
	}

	if (result.length !== nodes.size) {
		const visited = new Set(result);
		const remaining = [...nodes].filter((n) => !visited.has(n));
		throw new Error(`Circular dependency detected among PR groups: ${remaining.join(', ')}`);
	}

	return result;
}
