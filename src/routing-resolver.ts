export interface ResolveRouteOptions {
	readonly planOverride?: string;
	readonly configRouting?: Readonly<Record<string, string>>;
	readonly labels?: readonly string[];
}

/**
 * Resolve which skill/route to inject into a worker prompt.
 *
 * Fallback chain (first match wins):
 * 1. Plan-level override (per PR group `route` field)
 * 2. Config routing lookup — labels are sorted alphabetically and joined
 *    with `+` to form the lookup key (e.g. `['bug', 'ready-for-agent']` → `"bug+ready-for-agent"`)
 * 3. `null` — caller should use direct implementation prompt
 */
export function resolveRoute(options: ResolveRouteOptions): string | null {
	if (options.planOverride) return options.planOverride;

	if (options.configRouting && options.labels?.length) {
		const key = [...options.labels].sort().join('+');
		const match = options.configRouting[key];
		if (match) return match;
	}

	return null;
}
