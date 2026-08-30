/**
 * Collect a rank-banded corpus of human games from OGS.
 *
 *   node experiments/katago/fetch-ogs.ts \
 *     --band 6k-3k --games 60 --out experiments/corpus/6k-3k
 *
 * See docs/design-rank-survey.md §3 for why the discovery works the way it
 * does. In short: OGS removed the global game list, so the only way in is
 * through players. Random game ids seed the search, and each in-band player
 * found leads to more, bounded so that one prolific account cannot dominate
 * a band the way the original corpus was dominated by one player.
 *
 * Reads need no authentication. They are throttled under load, so requests
 * go out one per second, serially, and back off on 429.
 */
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://online-go.com/api/v1';
const REQUEST_INTERVAL_MS = 1000;
const RETRIES = 4;
const RETRY_BACKOFF_MS = 10_000;
/**
 * Games kept per player. Overridable with `--cap`, which the thinnest bands
 * need: 7d+ has so few reachable accounts that a cap of 3 puts a ceiling of
 * roughly twenty games on the whole band.
 */
const DEFAULT_PER_PLAYER_CAP = 3;
const MIN_DISTINCT_PLAYERS = 20;
const MIN_MOVES = 50;
/**
 * OGS reports `handicap: 1` for an even game played with reduced komi — no
 * stones are placed. Those are usable: komi reaches KataGo through the SGF,
 * so point loss is still measured against the right baseline. Anything that
 * actually places stones is not, and is caught by the `AB[]` check in `keep`.
 */
const MAX_HANDICAP = 1;
/**
 * How far outside the band a seed player may sit. Kept tight: OGS matches by
 * rank, so a player far from the band plays opponents who are also far from
 * it, and expanding them burns requests without ever producing a game.
 */
const SEED_MARGIN = 3;
/**
 * Glicko deviation above which a rating says nothing. A new account carries
 * rating 1500 and deviation 350 — the prior, not a measurement — and banding
 * on it would file an unrated player as a 6k. OGS displays `?` for these.
 */
const MAX_RATING_DEVIATION = 160;
/**
 * Game ids are dense; 90M answered and 95M did not when this was written.
 * Seeds are drawn from the recent end, both because contemporary play is what
 * we are studying and because the rating scale has shifted over the years.
 */
const SEED_ID_RANGE: readonly [number, number] = [60_000_000, 90_000_000];

/**
 * OGS rank number from a Glicko rating. Displayed kyu `K` covers
 * `[30-K, 31-K)` and dan `D` covers `[29+D, 30+D)`, so 1d starts at 30.
 *
 * The dan half was wrong by one rank in the first version of this file, which
 * is exactly what the cross-check against the SGF's own `BR`/`WR` is for: the
 * kyu bands reconciled 60/60 while the first dan band reconciled 0/60.
 */
function rankNumber(rating: number): number {
  return Math.log(rating / 525) * 23.15;
}

/** Rank number formatted the way OGS displays it, for cross-checking. */
function rankLabel(r: number): string {
  return r < 30 ? `${Math.ceil(30 - r)}k` : `${Math.floor(r - 29)}d`;
}

/** Half-open rank-number intervals. */
const BANDS: Readonly<Record<string, readonly [number, number]>> = {
  '25k-20k': [5, 11],
  '15k-10k': [15, 21],
  '6k-3k': [24, 28],
  '1d-3d': [30, 33],
  '4d-6d': [33, 36],
  '7d+': [36, Infinity],
};

interface Player {
  readonly id: number;
  readonly username: string;
  readonly ui_class: string;
  readonly ratings: {
    readonly overall: { readonly rating: number; readonly deviation: number };
  };
}

interface Game {
  readonly id: number;
  readonly width: number;
  readonly handicap: number;
  readonly ranked: boolean;
  readonly annulled: boolean;
  readonly outcome: string;
  readonly ended: string | null;
  readonly komi: string;
  readonly rules: string;
  readonly black: number;
  readonly white: number;
  readonly players: { readonly black: Player; readonly white: Player };
  /** Ratings as they stood when the game was played, not as they stand now. */
  readonly historical_ratings?: {
    readonly black?: Player;
    readonly white?: Player;
  };
}

interface GroupMember {
  readonly user: Player;
}

interface Manifest {
  readonly file: string;
  readonly gameId: number;
  readonly band: string;
  readonly server: 'ogs';
  readonly black: { readonly id: number; readonly rating: number; readonly rank: string };
  readonly white: { readonly id: number; readonly rating: number; readonly rank: string };
  readonly sgfRanks: { readonly black: string | null; readonly white: string | null };
  readonly agrees: boolean;
  readonly moves: number;
  /** Kept rather than filtered on: a game decided by timeout still contains
   *  real play, but the analysis may want to set those aside. */
  readonly outcome: string;
  readonly komi: string;
  readonly rules: string;
  readonly ended: string | null;
}

// --- transport -------------------------------------------------------------

let lastRequest = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One request per second, serially, with a slow retry on throttling.
 *
 * The `accept` header matters: the SGF endpoint answers 406 to a request that
 * asks for JSON.
 */
async function get(url: string, accept = 'application/json'): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait: number = lastRequest + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const response: Response = await fetch(url, { headers: { Accept: accept } });
      if (response.status !== 429) return response;
      if (attempt >= RETRIES) throw new Error(`throttled ${RETRIES + 1} times: ${url}`);
      console.error('  429, backing off');
    } catch (error) {
      // A crawl runs for tens of minutes over thousands of requests, so a
      // dropped connection is expected rather than exceptional. Letting it
      // propagate loses the whole run; only a persistent failure should.
      if (error instanceof Error && error.message.startsWith('throttled')) throw error;
      if (attempt >= RETRIES) throw error;
      console.error(`  ${(error as Error).message}, retrying`);
    }
    await sleep(RETRY_BACKOFF_MS * (attempt + 1));
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  const response: Response = await get(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

// --- filtering -------------------------------------------------------------

/**
 * The rating a player carried into this game, or null if OGS did not really
 * know it.
 */
function ratingAt(game: Game, color: 'black' | 'white'): number | null {
  const overall = game.historical_ratings?.[color]?.ratings?.overall;
  if (typeof overall?.rating !== 'number' || overall.rating <= 0) return null;
  if (overall.deviation > MAX_RATING_DEVIATION) return null;
  return overall.rating;
}

function isBot(player: Player | undefined): boolean {
  return (player?.ui_class ?? '').toLowerCase().includes('bot');
}

/**
 * Everything decidable from metadata. Board size and handicap both change what
 * a point of score lead means; unranked and annulled games have no rating to
 * band by; bots are the confound this whole survey exists to remove.
 */
function admissible(
  game: Game, band: readonly [number, number], since: string | undefined,
): boolean {
  if (game.width !== 19 || game.handicap < 0 || game.handicap > MAX_HANDICAP) return false;
  if (!game.ranked || game.annulled || !game.ended) return false;
  // Deep pagination walks back through a player's whole history. A game from
  // a decade ago is a different meta under a different rating calibration, so
  // it does not belong in a band next to games from last year.
  if (since !== undefined && game.ended < since) return false;
  if (isBot(game.players?.black) || isBot(game.players?.white)) return false;
  for (const color of ['black', 'white'] as const) {
    const rating: number | null = ratingAt(game, color);
    if (rating === null) return false;
    const r: number = rankNumber(rating);
    if (r < band[0] || r >= band[1]) return false;
  }
  return true;
}

/** Why a game was passed over, for the seeding log. */
function describe(game: Game, since: string | undefined): string {
  const notes: string[] = [];
  if (game.width !== 19) notes.push(`${game.width}x${game.width}`);
  if (game.handicap < 0 || game.handicap > MAX_HANDICAP) notes.push(`handicap ${game.handicap}`);
  if (!game.ranked) notes.push('unranked');
  if (game.annulled) notes.push('annulled');
  if (!game.ended) notes.push('unfinished');
  else if (since !== undefined && game.ended < since) notes.push('too old');
  if (isBot(game.players?.black) || isBot(game.players?.white)) notes.push('bot');
  const unrated: boolean = (['black', 'white'] as const).some((c) => ratingAt(game, c) === null);
  if (unrated) notes.push('unrated');
  else if (notes.length === 0) notes.push('out of band');
  return notes.join(', ');
}

/** Counts of why games were passed over, summarized rather than listed. */
type Tally = Map<string, number>;

function bump(tally: Tally, reason: string): void {
  tally.set(reason, (tally.get(reason) ?? 0) + 1);
}

function summarize(tally: Tally): string {
  return [...tally].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ');
}

function countMoves(sgf: string): number {
  return (sgf.match(/;[BW]\[/g) ?? []).length;
}

function sgfRank(sgf: string, color: 'B' | 'W'): string | null {
  return new RegExp(`${color}R\\[([^\\]]*)\\]`).exec(sgf)?.[1] ?? null;
}

// --- collection ------------------------------------------------------------

interface State {
  readonly kept: Map<number, Manifest>;
  readonly perPlayer: Map<number, number>;
  readonly pairs: Set<string>;
  readonly seen: Set<number>;
  readonly queue: number[];
  readonly queued: Set<number>;
}

function pairKey(game: Game): string {
  return [game.black, game.white].sort((a, b) => a - b).join(':');
}

/** Caps that keep one prolific account from standing in for a whole band. */
function withinCaps(game: Game, state: State, cap: number): boolean {
  if (state.pairs.has(pairKey(game))) return false;
  return [game.black, game.white].every((id) => (state.perPlayer.get(id) ?? 0) < cap);
}

async function keep(
  game: Game, band: string, state: State, outDir: string, tally: Tally,
): Promise<boolean> {
  const response: Response = await get(`${API}/games/${game.id}/sgf`, 'application/x-go-sgf, text/plain, */*');
  if (!response.ok) { bump(tally, `sgf-http-${response.status}`); return false; }
  const sgf: string = await response.text();
  const moves: number = countMoves(sgf);
  if (moves < MIN_MOVES) { bump(tally, 'too short'); return false; }
  // The metadata says how many handicap stones were agreed; the record says
  // whether any were actually placed. Trust the record.
  if (/AB\[/.test(sgf)) { bump(tally, 'handicap stones'); return false; }

  const file = `ogs-${band}-${game.id}.sgf`;
  writeFileSync(join(outDir, file), sgf);

  const rating = (color: 'black' | 'white'): number => ratingAt(game, color) ?? 0;
  const derived = {
    black: rankLabel(rankNumber(rating('black'))),
    white: rankLabel(rankNumber(rating('white'))),
  };
  const sgfRanks = { black: sgfRank(sgf, 'B'), white: sgfRank(sgf, 'W') };
  const record: Manifest = {
    file, gameId: game.id, band, server: 'ogs',
    black: { id: game.black, rating: rating('black'), rank: derived.black },
    white: { id: game.white, rating: rating('white'), rank: derived.white },
    sgfRanks,
    agrees: sgfRanks.black === derived.black && sgfRanks.white === derived.white,
    moves, outcome: game.outcome, komi: game.komi, rules: game.rules, ended: game.ended,
  };
  appendFileSync(join(outDir, 'manifest.jsonl'), JSON.stringify(record) + '\n');

  state.kept.set(game.id, record);
  state.pairs.add(pairKey(game));
  console.error(
    `${state.kept.size} games — ${game.id}, ${record.black.rank}/${record.white.rank}, ${moves} moves`,
  );
  for (const id of [game.black, game.white]) {
    state.perPlayer.set(id, (state.perPlayer.get(id) ?? 0) + 1);
    if (!state.queued.has(id)) { state.queued.add(id); state.queue.push(id); }
  }
  return true;
}

/** Deterministic, so a run can be reproduced from its seed. */
function makeRandom(seed: number): () => number {
  let s: number = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Draw a random game and harvest its players, not the game itself.
 *
 * Very little of OGS is an unhandicapped ranked 19x19 game between two
 * bot-free accounts in one narrow band — under 3% in practice, and most draws
 * are 9x9, handicapped, or against a bot. But a player *near* the band is
 * common, and every player leads to a filtered list of their own games. So
 * seeding looks for accounts to expand rather than games to keep.
 */
async function seedFromRandomGame(
  band: string, state: State, random: () => number, since: string | undefined,
): Promise<void> {
  const [lo, hi] = SEED_ID_RANGE;
  const id: number = lo + Math.floor(random() * (hi - lo));
  if (state.seen.has(id)) return;
  state.seen.add(id);
  const game: Game | null = await getJson<Game>(`${API}/games/${id}`);
  if (!game || game.width !== 19) return;

  const [low, high] = BANDS[band];
  let found = 0;
  for (const color of ['black', 'white'] as const) {
    const rating: number | null = ratingAt(game, color);
    if (rating === null || isBot(game.players?.[color])) continue;
    const r: number = rankNumber(rating);
    if (r < low - SEED_MARGIN || r >= high + SEED_MARGIN) continue;
    const playerId: number = color === 'black' ? game.black : game.white;
    if (state.queued.has(playerId)) continue;
    state.queued.add(playerId);
    state.queue.push(playerId);
    found++;
  }
  if (found > 0) console.error(`  ${id}: queued ${found} player(s) near the band`);
}

/** Queue both players of a game if they are bot-free and inside the band. */
function enqueueInBand(game: Game, band: string, state: State): void {
  const [low, high] = BANDS[band];
  for (const color of ['black', 'white'] as const) {
    const rating: number | null = ratingAt(game, color);
    if (rating === null || isBot(game.players?.[color])) continue;
    const r: number = rankNumber(rating);
    if (r < low || r >= high) continue;
    const id: number = color === 'black' ? game.black : game.white;
    if (state.queued.has(id)) continue;
    state.queued.add(id);
    state.queue.push(id);
  }
}

async function expandPlayer(
  playerId: number, band: string, state: State, outDir: string,
  target: number, cap: number, pages: number, since: string | undefined,
): Promise<void> {
  const tally: Tally = new Map();
  const before: number = state.kept.size;
  let scanned = 0;
  let url: string | null =
    `${API}/players/${playerId}/games/?width=19&ranked=true&page_size=50`;
  // Deeper pagination is how a thin band finds more accounts: each further
  // page of a strong player's history surfaces opponents the first page missed.
  for (let page = 0; page < pages && url !== null; page++) {
    const body: { results: Game[]; next: string | null } | null =
      await getJson<{ results: Game[]; next: string | null }>(url);
    if (!body) break;
    url = body.next;
    scanned += body.results.length;
    if (await scanGames(body.results, band, state, outDir, target, cap, tally, since)) break;
    // Histories come back newest first, so once a whole page predates the
    // cutoff every later page does too. Without this, deep pagination spends
    // most of its requests on games the filter will throw away.
    if (since !== undefined && body.results.every((g) => (g.ended ?? '') < since)) break;
  }
  console.error(
    `player ${playerId}: +${state.kept.size - before} of ${scanned}` +
    ` (${state.kept.size} kept, ${state.queue.length} queued) — ${summarize(tally)}`,
  );
}

/** Returns true when the target has been reached and scanning should stop. */
async function scanGames(
  games: readonly Game[], band: string, state: State, outDir: string,
  target: number, cap: number, tally: Tally, since: string | undefined,
): Promise<boolean> {
  for (const game of games) {
    if (state.kept.size >= target) return true;
    // Follow every in-band player met along the way, even through a game that
    // is itself unusable. Otherwise a run of handicap games or bot opponents
    // ends the crawl, and the walk has no way back toward the band.
    enqueueInBand(game, band, state);
    if (state.seen.has(game.id)) { bump(tally, 'seen'); continue; }
    state.seen.add(game.id);
    if (!admissible(game, BANDS[band], since)) { bump(tally, describe(game, since)); continue; }
    if (!withinCaps(game, state, cap)) { bump(tally, 'over cap'); continue; }
    await keep(game, band, state, outDir, tally);
  }
  return false;
}

// --- entry point -----------------------------------------------------------

function parseArgs(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

/**
 * Prime the queue with players from another band's manifest.
 *
 * A band as thin as 7d+ cannot be reached by random seeding: a draw almost
 * never lands on one, and the walk only follows players who are already in
 * band, so it has no way to climb. Neighboring players do meet them, though,
 * so their game lists are the way in.
 */
function seedFromManifest(path: string, state: State): void {
  let added = 0;
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as Manifest;
    for (const id of [record.black.id, record.white.id]) {
      if (state.queued.has(id)) continue;
      state.queued.add(id);
      state.queue.push(id);
      added++;
    }
  }
  console.error(`primed with ${added} players from ${path}`);
}

/**
 * Prime the queue from an OGS group's membership.
 *
 * OGS has no rating leaderboard, by policy: the forums explain that such
 * lists fill up with bots, inflated provisional ratings and dormant accounts.
 * Group membership is the closest thing, and group 515 ("OGS Title
 * Tournaments", ~3000 members) is where the strong players are. Unlike
 * `--seed-from`, this needs no earlier crawl to have happened.
 *
 * The same caveat the forums raise applies here and not to the game-walk: a
 * membership list is full of accounts that never played the games we want.
 * `admissible` still decides, so a seed only ever costs a request.
 */
async function seedFromGroup(
  groupId: string, band: string, state: State,
): Promise<void> {
  const [low, high] = BANDS[band];
  let url: string | null = `${API}/groups/${groupId}/members/?page_size=100`;
  let added = 0;
  while (url !== null) {
    const page: { results: GroupMember[]; next: string | null } | null =
      await getJson<{ results: GroupMember[]; next: string | null }>(url);
    if (!page) break;
    url = page.next;
    for (const { user } of page.results) {
      const overall = user.ratings?.overall;
      if (!overall || overall.deviation > MAX_RATING_DEVIATION) continue;
      if (isBot(user)) continue;
      const r: number = rankNumber(overall.rating);
      if (r < low - SEED_MARGIN || r >= high + SEED_MARGIN) continue;
      if (state.queued.has(user.id)) continue;
      state.queued.add(user.id);
      state.queue.push(user.id);
      added++;
    }
  }
  console.error(`primed with ${added} players from group ${groupId}`);
}

function loadState(outDir: string): State {
  const state: State = {
    kept: new Map(), perPlayer: new Map(), pairs: new Set(),
    seen: new Set(), queue: [], queued: new Set(),
  };
  const path: string = join(outDir, 'manifest.jsonl');
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as Manifest;
    state.kept.set(record.gameId, record);
    state.seen.add(record.gameId);
    const ids: readonly number[] = [record.black.id, record.white.id];
    state.pairs.add([...ids].sort((a, b) => a - b).join(':'));
    for (const id of ids) {
      state.perPlayer.set(id, (state.perPlayer.get(id) ?? 0) + 1);
      if (!state.queued.has(id)) { state.queued.add(id); state.queue.push(id); }
    }
  }
  console.error(`resuming: ${state.kept.size} games already collected`);
  return state;
}

async function main(): Promise<void> {
  const flags: Record<string, string> = parseArgs(process.argv.slice(2));
  const band: string = flags.band;
  if (!(band in BANDS)) {
    throw new Error(`--band must be one of ${Object.keys(BANDS).join(', ')}`);
  }
  const target: number = Number(flags.games ?? 60);
  const cap: number = Number(flags.cap ?? DEFAULT_PER_PLAYER_CAP);
  const pages: number = Number(flags.pages ?? 1);
  const since: string | undefined = flags.since;
  // A thin band seeded from a group list spends most of its expansions on
  // dormant accounts, so it needs far more patience than a dense one.
  const patience: number = Number(flags.patience ?? 200);
  const outDir: string = flags.out ?? `experiments/corpus/${band}`;
  const random: () => number = makeRandom(Number(flags.seed ?? 1));
  mkdirSync(outDir, { recursive: true });

  const state: State = loadState(outDir);
  const seedFrom: string | undefined = flags['seed-from'];
  if (seedFrom !== undefined) seedFromManifest(seedFrom, state);
  const seedGroup: string | undefined = flags['seed-from-group'];
  if (seedGroup !== undefined) await seedFromGroup(seedGroup, band, state);
  let sinceProgress = 0;
  while (state.kept.size < target) {
    const before: number = state.kept.size;
    const playerId: number | undefined = state.queue.shift();
    if (playerId === undefined) await seedFromRandomGame(band, state, random, since);
    else await expandPlayer(playerId, band, state, outDir, target, cap, pages, since);

    if (state.kept.size > before) {
      sinceProgress = 0;
    } else if (++sinceProgress >= patience) {
      console.error(`${patience} requests without progress; stopping`);
      break;
    }
  }

  const disagreements: Manifest[] = [...state.kept.values()].filter((r) => !r.agrees);
  console.error(
    `\n${state.kept.size} games, ${state.perPlayer.size} distinct players, ${outDir}`,
  );
  if (state.perPlayer.size < MIN_DISTINCT_PLAYERS) {
    console.error(`WARNING: fewer than ${MIN_DISTINCT_PLAYERS} distinct players`);
  }
  // The rank mapping is off-by-one prone; the SGF carries what OGS displayed.
  if (disagreements.length > 0) {
    console.error(`WARNING: band assignment disagrees with the SGF on ${disagreements.length}:`);
    for (const r of disagreements.slice(0, 5)) {
      console.error(`  ${r.gameId}: derived ${r.black.rank}/${r.white.rank}, sgf ${r.sgfRanks.black}/${r.sgfRanks.white}`);
    }
  }
}

await main();
