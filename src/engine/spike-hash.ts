/**
 * The diagnostic fragments, alone in a module so `main.ts` can route on them
 * without statically importing `spike.ts` or `probe.ts` — which would pull the
 * model parser, and for the probe TensorFlow.js itself, into the main bundle
 * and undo the point of loading either dynamically.
 */
export const SPIKE_HASH = '#spike';

/** The device probe: does this GPU compute the network correctly? */
export const PROBE_HASH = '#probe';
