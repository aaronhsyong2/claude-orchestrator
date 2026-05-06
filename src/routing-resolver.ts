export interface ResolveRouteOptions {
	readonly planOverride?: string;
	readonly configRouting?: Readonly<Record<string, string>>;
	readonly labels?: readonly string[];
}

export function resolveRoute(options: ResolveRouteOptions): string | null {
	if (options.planOverride) return options.planOverride;

	if (options.configRouting && options.labels?.length) {
		const key = [...options.labels].sort().join('+');
		const match = options.configRouting[key];
		if (match) return match;
	}

	return null;
}
