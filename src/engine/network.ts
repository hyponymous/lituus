/**
 * Which network ships, where it comes from, and where the app looks for it.
 *
 * One descriptor, read by three things that must not disagree: the build
 * script that downloads it, the page that fetches it, and the record of which
 * engine produced a score (PRD §9). A second copy of the filename in a
 * workflow YAML is exactly the sort of drift that only shows up in production.
 *
 * `b15c192 @ 50 visits` is the floor the measurements permit, not a preference
 * — smaller networks cannot be made trustworthy at any visit count. See
 * `docs/katago-feasibility.md` §5.
 */

export interface Network {
  /** Short name, as the docs and the recorded engine configuration use it. */
  readonly label: string;
  /** Filename as served, and as downloaded. Kept identical to upstream's. */
  readonly file: string;
  /** Where the build fetches it from. Not fetchable from a browser — see below. */
  readonly url: string;
  /** Expected size in bytes, as a check that the download completed. */
  readonly bytes: number;
  /**
   * SHA-256 of the *inflated* weights, and the size they inflate to.
   *
   * A completed download is not an intact one. The only integrity check this
   * had was the compressed length and the first sixty-four bytes being a
   * plausible header, which a body damaged anywhere after that passes — it then
   * parses, evaluates, and returns numbers that are finite, stable and wrong.
   * The weights are the one input to the engine nothing else can vouch for, so
   * they are hashed.
   */
  readonly inflatedBytes: number;
  readonly sha256: string;
}

/**
 * Fetched at build time and served from our own origin, because it cannot be
 * fetched any other way: neither `media.katagotraining.org` nor
 * `katagoarchive.org` sends `Access-Control-Allow-Origin`, on a GET or on a
 * preflight (measured 2026-08-30). A browser on the deployed site therefore
 * cannot read a network from either. See `docs/design-ai-scoring.md` §10b.
 */
export const NETWORK: Network = {
  label: 'b15c192',
  file: 'g170e-b15c192-s1672170752-d466197061.bin.gz',
  url: 'https://katagoarchive.org/g170/neuralnets/g170e-b15c192-s1672170752-d466197061.bin.gz',
  bytes: 36_948_927,
  inflatedBytes: 39_776_212,
  sha256: '7a1fe84a36c6ff535dbfad1219a3ce4c040babe889712378a9d18a9276234faa',
};

/** Subdirectory of the published site the network is served from. */
export const NETWORK_DIR = 'nets';

/**
 * Where the running page should fetch the network from.
 *
 * Built from Vite's `BASE_URL` rather than an absolute path, because the site
 * is published under `/lituus/` and a leading-slash URL would resolve to the
 * domain root — which works perfectly in `npm run dev` and 404s in production.
 *
 * The base is a parameter so this module can be imported by a Node script,
 * where `import.meta.env` does not exist. Default arguments are evaluated at
 * call time, so merely importing this file is safe there.
 */
export function networkUrl(base: string = import.meta.env.BASE_URL): string {
  return `${base.endsWith('/') ? base : `${base}/`}${NETWORK_DIR}/${NETWORK.file}`;
}
