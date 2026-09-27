import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** Names of the on-demand views whose code has been fetched so far. */
const loaded = new Set<string>();

/**
 * React.lazy for a named export, remembering (by name) which views have
 * actually been loaded — so tests on the real app can check that a view is
 * not fetched before it is first opened.
 */
export function lazyView<T extends ComponentType<any>>(
	name: string,
	load: () => Promise<T>,
): LazyExoticComponent<T> {
	return lazy(() =>
		load().then((component) => {
			loaded.add(name);
			return { default: component };
		}),
	);
}

export function loadedViews(): string[] {
	return [...loaded].sort();
}
