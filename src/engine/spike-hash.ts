/**
 * The spike's fragment, alone in a module so `main.ts` can route on it without
 * statically importing `spike.ts` — which would pull the model parser into the
 * main bundle and undo the point of loading the spike dynamically.
 */
export const SPIKE_HASH = '#spike';
