/**
 * The main thread's view of the analysis engine.
 *
 * Owns the worker, the four lifecycle states the session view has to be able to
 * show (§5.2), and an `Evaluator` that the existing queue drains without
 * knowing any of it. Nothing above this line imports the engine, and this file
 * imports it only through `new Worker(new URL(...))` — which is what keeps
 * TensorFlow.js out of the main bundle.
 *
 * **Failure degrades, it does not end.** A missing WebGPU, a failed download, a
 * network that will not parse: all of them leave the session running and the
 * summary reporting exact match only, with a plain statement of why. That is
 * the same shape a session with AI switched off has, so it is the path most
 * likely to be right — and the replay evaluator exercises it without breaking
 * a network.
 *
 * **A crash restarts, within limits.** A worker killed for memory or a GPU lost
 * mid-session is replaced and asked again (`startEngine`); only a failure that
 * would repeat, or one too many, ends scoring.
 */

import type { EngineConfig, Verdict } from './analysis.ts';
import { EvaluationError, type Evaluator, type Prompt } from './evaluator.ts';
import type { Game } from './game.ts';
import { isMobile } from './device.ts';
import { serialize } from './sgf-writer.ts';
import { NETWORK, networkUrl } from './engine/network.ts';
import { NETWORK_BYTES, isNetworkCached } from './engine/net-cache.ts';
import type { WorkerReply, WorkerRequest } from './engine/worker.ts';

/** Visits per search, and not a preference: see `docs/katago-feasibility.md` §5. */
export const VISITS = 50;

/**
 * Failed prompts in a row before scoring is called dead rather than unlucky.
 *
 * One failure is not fatal and never has been — a single search can hit a
 * position the engine refuses and the summary simply reports what it has. A
 * *run* of them is a different event: the engine has stopped, and every later
 * prompt will fail too. Without this the session goes on asking, the errors are
 * dropped one at a time, and the only visible trace is a summary quietly
 * missing its last fifty moves.
 *
 * Three, because two in a row is within reach of coincidence and the cost of
 * being late by one prompt is nothing. The count resets on any verdict, so a
 * scattered failure never accumulates into a false alarm.
 *
 * Only for errors the worker does not mark retryable. One that is — a device
 * dying under the prompt — restarts the engine on the first occurrence and
 * asks the same prompt again, rather than losing three moves to find out.
 */
export const ERRORS_BEFORE_FAILED = 3;

/**
 * What the session view shows about the engine.
 *
 * `downloading` carries a fraction rather than a percentage because the
 * fraction can legitimately exceed 1 — a host that inflates on the way in
 * reports the compressed length against an inflated body (`net-cache.ts`) — and
 * clamping is the view's decision, not this module's.
 */
export type EngineStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'downloading'; readonly received: number; readonly total: number | null }
  | { readonly state: 'warming' }
  | { readonly state: 'ready' }
  /**
   * The worker died and a new one is being built, or will be at the next
   * prompt. Prompts asked meanwhile wait for it rather than failing.
   */
  | { readonly state: 'restarting' }
  | { readonly state: 'failed'; readonly reason: string };

export interface EngineHandle {
  readonly evaluator: Evaluator;
  readonly status: () => EngineStatus;
  /**
   * Re-read one move's line at a larger budget, resolving to what was read or
   * to null.
   *
   * Null means *nothing was read* — the pass gave way to a scoring prompt, or
   * the engine is not up — and a caller may honestly ask again later. It is
   * never a partial answer: anything that was read arrives as the line plus
   * the visits actually spent on it, which is the only `pvBudget` that line
   * can truthfully carry (a timed-out pass spends less than it was asked to).
   * Nothing here ever rejects, because nothing about a longer line is worth
   * interrupting a reader over.
   */
  readonly deepen: (
    moveNumber: number,
    point: number | null,
    visits: number,
  ) => Promise<Deepened | null>;
  /** Stop the worker and release the GPU. Safe to call twice. */
  readonly stop: () => void;
}

/** One line read at a larger budget: the plies, and the visits actually spent. */
export interface Deepened {
  readonly pv: readonly number[];
  readonly visits: number;
}

/** A reading of what the worker holds, as `worker.ts` reports it. */
export type EngineMemory = Extract<WorkerReply, { type: 'memory' }>;

export interface EngineOptions {
  /** Called whenever the status changes, so the view can redraw. */
  readonly onStatus?: (status: EngineStatus) => void;
  /**
   * Called once, with what the engine turned out to be running on. Separate
   * from `onStatus` because it is not a state: it is a fact about the run that
   * the store keeps, and it arrives when the backend does.
   */
  readonly onDevice?: (device: string) => void;
  /**
   * What the worker holds, after every prompt.
   *
   * For a harness watching a long run: whether live bytes climb is the whole
   * of the leak-or-high-water-mark question, and one reading cannot answer it.
   * The product ignores this — a failure already carries the two readings that
   * matter (`lastWords`).
   */
  readonly onMemory?: (reading: EngineMemory) => void;
  /**
   * Called when a worker died and is being replaced, with the move in flight
   * and why it died, for the store to keep as an incident that is not a
   * failure: whatever was in flight is asked again.
   */
  readonly onRestart?: (restart: { readonly move: number | null; readonly reason: string }) => void;
  /** What starts a worker. Tests pass one that can be killed on cue. */
  readonly spawn?: Spawn;
  /** Whether the network is still cached, so a restart downloads nothing. */
  readonly isCached?: () => Promise<boolean>;
  /**
   * Where the network comes from; the page's own by default. Passed by a test,
   * which has no `import.meta.env` to build the default from (`networkUrl`).
   */
  readonly networkUrl?: string;
}

/**
 * Why a record cannot be scored, or null if it can.
 *
 * Square boards only, and it is the V7 feature encoding that says so rather
 * than a policy: it indexes by one board dimension (PRD §12, design §7). Said
 * here, once, so the setup view can explain the absence instead of offering a
 * toggle that fails later.
 */
export function unscorableReason(game: Game): string | null {
  if (game.cols !== game.rows) {
    return `AI scoring needs a square board, and this record is ${game.cols}x${game.rows}.`;
  }
  return null;
}

/** The engine that produced a set of verdicts, for the record a score carries. */
export function engineConfig(): EngineConfig {
  // Null until the worker has a backend to ask; `onReady` carries the answer.
  return { network: NETWORK.label, visits: VISITS, backend: 'webgpu', device: null };
}

/**
 * Why scoring may not finish here, or null where nothing is known against it.
 *
 * Not a refusal, unlike `unscorableReason` — the toggle stays on and the
 * download stays offered. A phone can score a session and often does; it can
 * also run its GPU out partway through, and the engine's own checks then stop
 * it rather than let it answer. Said before the download starts, because the
 * download is the part that cannot be taken back.
 *
 * It used to warn that a phone may compute the network incorrectly, which was
 * true of one and is no longer true of any: the fault was a readback this build
 * now pads past (`aligned-read.ts`), and a device that still disagrees with the
 * reference is refused at load rather than believed. What is left is memory and
 * time, which are the phone's own.
 */
export function unreliableReason(): string | null {
  if (!isMobile()) return null;
  return (
    'A phone can run its GPU out partway through a long game. Scoring restarts ' +
    'when that happens, but if it keeps happening it stops, and the review ' +
    'covers only the moves it reached.'
  );
}

/** Roughly how much there is to download, for copy written before it starts. */
export const DOWNLOAD_BYTES: number = NETWORK_BYTES;

/**
 * Restarts allowed before a death is called final.
 *
 * Three, and forgiven after `CLEAN_TO_FORGIVE` verdicts since the last one: a
 * long game on a phone that dies every hundred moves should finish, and one
 * that dies on every prompt should not spend the evening trying. A position
 * that kills the worker twice is skipped on its own (`startEngine`), so this
 * budget is about the device, not about one bad move.
 */
export const RESTARTS_ALLOWED = 3;

/** Verdicts after a restart that earn the budget back; see `RESTARTS_ALLOWED`. */
export const CLEAN_TO_FORGIVE = 50;

/**
 * What the client needs of a worker.
 *
 * A seam, so the restart logic can be tested against a worker that dies on
 * cue; `spawnWorker` is the real one. Deaths and replies arrive through the
 * callbacks given to `Spawn`, which is what lets the client tell one worker's
 * last words from its replacement's first.
 */
export interface WorkerPort {
  readonly post: (request: WorkerRequest) => void;
  /** Stop it, and hear nothing more from it. */
  readonly terminate: () => void;
}

export type Spawn = (
  onReply: (reply: WorkerReply) => void,
  onDeath: (message: string) => void,
) => WorkerPort;

function spawnWorker(
  onReply: (reply: WorkerReply) => void,
  onDeath: (message: string) => void,
): WorkerPort {
  /*
   * `new URL('./engine/worker.ts', import.meta.url)` and not a bare specifier.
   * Vite rewrites this form to the hashed, base-pathed asset URL; a string
   * specifier survives `npm run dev` and 404s under `/lituus/`, which is
   * exactly the class of failure the deployment spike existed to find (§10b).
   */
  const worker = new Worker(new URL('./engine/worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<WorkerReply>): void => onReply(event.data);
  // A worker that dies outright — an out-of-memory kill on a phone is the
  // realistic case — reports nothing else, so this is the only place that
  // failure becomes visible.
  worker.onerror = (event: ErrorEvent): void => onDeath(event.message);
  return {
    post: (request: WorkerRequest): void => worker.postMessage(request),
    terminate: (): void => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    },
  };
}

type EvaluateRequest = Extract<WorkerRequest, { type: 'evaluate' }>;

/**
 * Run the engine for one record, restarting its worker when a fresh one could
 * do better.
 *
 * **A death is not the end of scoring.** A phone kills a worker that runs it
 * out of memory, and loses a GPU device under pressure; a new worker starts
 * with neither problem. So a death a restart can fix — an outright kill, a lost
 * device, a readback gone dead — terminates the worker, builds another, and
 * asks it whatever was in flight. The queue above never hears about it: a
 * prompt in flight across a restart just takes longer to answer.
 *
 * A restart never passes through `failed`. That state is final everywhere it
 * is read — `main.ts` records a fatal incident on entering it, and the summary
 * quotes that incident as where scoring stopped — so a death that is going to
 * be survived is `restarting` instead.
 *
 * What is never restarted:
 * - a death the worker marks final: no WebGPU, a device refused against the
 *   reference, weights that would not arrive intact, a canary that drifted.
 *   Each would happen again, the same way, on the same device.
 * - a death before the engine was ever ready, which is one of those or a
 *   download that failed, and either way not a crash a restart recovers from.
 * - a death once `RESTARTS_ALLOWED` is spent.
 * - a death once the network has left the cache. iOS evicts Cache storage under
 *   the same memory pressure that kills the worker, and a restart would then
 *   quietly spend another 37MB of the reader's data on a download they agreed
 *   to once (`unreliableReason`).
 *
 * The replacement is built lazily, when there is a prompt for it: a device lost
 * because the tab went to the background would only be lost again by a worker
 * built there.
 */
export function startEngine(game: Game, options: EngineOptions = {}): EngineHandle {
  const spawn: Spawn = options.spawn ?? spawnWorker;
  const url: string = options.networkUrl ?? networkUrl();
  const isCached: () => Promise<boolean> =
    options.isCached ?? ((): Promise<boolean> => isNetworkCached(url));

  let status: EngineStatus = { state: 'idle' };
  let stopped = false;

  const setStatus = (next: EngineStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  /** The live worker, or null between a death and its replacement. */
  let port: WorkerPort | null = null;
  /** Bumped for every worker let go, so anything it still says is dropped. */
  let generation = 0;
  /** Whether any worker has come up. A death before that is not retried. */
  let everReady = false;
  /** Restarts since the budget was last earned back; see `RESTARTS_ALLOWED`. */
  let restarts = 0;
  /** Verdicts since the last restart; see `CLEAN_TO_FORGIVE`. */
  let cleanSinceRestart = 0;
  /** Why the last worker died, for a restart that turns out not to be possible. */
  let lastDeath = '';
  /** A cache check is under way, so a second prompt does not start another. */
  let respawning = false;

  /**
   * Moves that were in flight when a worker died.
   *
   * A move in flight at a second death is skipped rather than asked a third
   * time. Some positions may simply cost more memory than the phone has, and
   * without this one of them would spend the whole restart budget on itself.
   */
  const killedAt = new Set<number>();

  /**
   * Prompts awaiting a verdict, keyed by move number. The request is kept so a
   * replacement worker can be asked it again.
   */
  const waiting = new Map<
    number,
    {
      readonly request: EvaluateRequest;
      readonly resolve: (verdict: Verdict) => void;
      readonly reject: (error: unknown) => void;
    }
  >();

  /** Deepening passes awaiting a line, keyed by move number. */
  const deepening = new Map<number, (read: Deepened | null) => void>();

  /** Failed prompts since the last verdict; see `ERRORS_BEFORE_FAILED`. */
  let consecutiveErrors = 0;

  /**
   * What the worker said about its memory, first and last, kept for its
   * obituary. Null until the engine is up, and reset for each worker, since a
   * replacement counts its prompts from zero again.
   *
   * Both, because one reading cannot answer the question a kill raises. A
   * worker holding what it started with was killed by something other than its
   * own appetite; one holding six times that grew into the ceiling, and the
   * pool's allocated total says whether the growth was live tensors or freed
   * buffers kept around.
   */
  let firstReading: EngineMemory | null = null;
  let lastReading: EngineMemory | null = null;

  /**
   * What the engine was holding when it stopped, if it ever said.
   *
   * Appended to the failure because the failure is the only thing that reaches
   * a reader — the status line, and the incident the export records. A kill
   * with no reading behind it is silent about why, and the phone is exactly
   * where that question keeps being asked (`TODO`: leak or high-water mark).
   */
  const lastWords = (): string => {
    if (!lastReading || !firstReading) return '';
    const mb = (bytes: number): string => `${Math.round(bytes / 1e6)}MB`;
    return (
      ` It was holding ${mb(lastReading.gpuBytes)} in ${lastReading.tensors} ` +
      `tensors ${lastReading.prompts} moves in, against ` +
      `${mb(firstReading.gpuBytes)} in ${firstReading.tensors} at the start; ` +
      `${mb(lastReading.gpuAllocated)} ever allocated.`
    );
  };

  /** Let the current worker go, so nothing it says from here on is heard. */
  const release = (): void => {
    generation++;
    port?.terminate();
    port = null;
    // A worker that is gone will not be deepening anything either, and a
    // promise that never settles would keep the scheduler waiting for it.
    // `main.ts` un-claims a move that comes back unread, so it is asked again.
    for (const settle of deepening.values()) settle(null);
    deepening.clear();
  };

  const failEverything = (reason: string): void => {
    for (const { reject } of waiting.values()) reject(new EvaluationError(reason));
    waiting.clear();
  };

  /** Scoring is over: say why, and answer everything still waiting with it. */
  const fail = (reason: string): void => {
    release();
    setStatus({ state: 'failed', reason });
    failEverything(reason);
  };

  /** A worker died. Restart it if a restart could help, or stop for good. */
  const died = (reason: string): void => {
    const words: string = reason + lastWords();
    release();
    firstReading = null;
    lastReading = null;

    if (!everReady) {
      fail(words);
      return;
    }
    if (restarts >= RESTARTS_ALLOWED) {
      fail(`${words} It had already been restarted ${restarts} times, so it was not restarted again.`);
      return;
    }

    // At most one in practice — the queue runs one prompt at a time — but the
    // map makes no such promise, so every one is accounted for.
    const inFlight: number | null = waiting.keys().next().value ?? null;
    for (const [moveNumber, { reject }] of waiting) {
      if (!killedAt.has(moveNumber)) {
        killedAt.add(moveNumber);
        continue;
      }
      waiting.delete(moveNumber);
      // Said as what was seen, not as blame: the second death may have been a
      // backgrounded tab or a replacement failing to start, not this position.
      reject(
        new EvaluationError(
          `The engine stopped twice while scoring move ${moveNumber}, so it was skipped.`,
        ),
      );
    }

    restarts++;
    cleanSinceRestart = 0;
    consecutiveErrors = 0;
    lastDeath = words;
    options.onRestart?.({ move: inFlight, reason: words });
    setStatus({ state: 'restarting' });
    if (waiting.size > 0) void respawn();
  };

  const onReply = (reply: WorkerReply): void => {
    switch (reply.type) {
      case 'progress':
        // A restart reads the network from the cache, and a download bar
        // filling for it would claim a download that is not happening.
        if (status.state === 'restarting') return;
        setStatus({ state: 'downloading', received: reply.received, total: reply.total });
        return;
      case 'warming':
        if (status.state === 'restarting') return;
        setStatus({ state: 'warming' });
        return;
      case 'ready':
        everReady = true;
        options.onDevice?.(reply.device);
        setStatus({ state: 'ready' });
        return;
      case 'failed':
        if (reply.retryable) died(reply.reason);
        // Anything already asked for will never be answered, so say so now
        // rather than leaving the queue holding promises that cannot settle.
        else fail(reply.reason);
        return;
      case 'memory':
        firstReading ??= reply;
        lastReading = reply;
        options.onMemory?.(reply);
        return;
      case 'verdict': {
        const moveNumber: number = reply.verdict.moveNumber;
        consecutiveErrors = 0;
        killedAt.delete(moveNumber);
        if (restarts > 0 && ++cleanSinceRestart >= CLEAN_TO_FORGIVE) restarts = 0;
        waiting.get(moveNumber)?.resolve(reply.verdict);
        waiting.delete(moveNumber);
        return;
      }
      case 'deepened': {
        const read: Deepened | null =
          reply.pv === null ? null : { pv: reply.pv, visits: reply.visits };
        deepening.get(reply.moveNumber)?.(read);
        deepening.delete(reply.moveNumber);
        return;
      }
      case 'error': {
        // The device died under this prompt. It stays waiting, and is asked
        // again of the worker that replaces this one.
        if (reply.retryable) {
          died(reply.reason);
          return;
        }
        waiting.get(reply.moveNumber)?.reject(new EvaluationError(reply.reason));
        waiting.delete(reply.moveNumber);
        // A run of them means the engine is gone, not that these positions
        // were awkward. The last reason is the reason: they are all the same
        // failure arriving once per prompt.
        if (++consecutiveErrors >= ERRORS_BEFORE_FAILED) fail(reply.reason);
        return;
      }
    }
  };

  const init: WorkerRequest = {
    type: 'init',
    // Serialized from the source tree, so the worker reads the same record
    // through the same parser rather than being handed a second model of it.
    sgf: serialize([game.source]),
    networkUrl: url,
    visits: VISITS,
  };

  /** Start a worker and tell it the record. Prompts queue behind the init. */
  const launch = (): WorkerPort => {
    const mine: number = generation;
    const fresh: WorkerPort = spawn(
      (reply: WorkerReply): void => {
        if (mine === generation) onReply(reply);
      },
      (message: string): void => {
        if (mine === generation) died(message || 'The analysis worker stopped unexpectedly.');
      },
    );
    port = fresh;
    fresh.post(init);
    return fresh;
  };

  /** Replace a dead worker, if the network is still here to build one from. */
  const respawn = async (): Promise<void> => {
    if (respawning || port !== null) return;
    respawning = true;
    const cached: boolean = await isCached().catch((): boolean => false);
    respawning = false;
    // Stopped, or failed some other way, while the cache was being asked.
    if (stopped || status.state !== 'restarting') return;
    if (!cached) {
      fail(
        `${lastDeath} It was not restarted, because its network is no longer ` +
          'saved on this device and restarting would download it again.',
      );
      return;
    }
    const fresh: WorkerPort = launch();
    for (const { request } of waiting.values()) fresh.post(request);
  };

  setStatus({ state: 'downloading', received: 0, total: null });
  launch();

  const evaluator: Evaluator = {
    config: engineConfig(),
    evaluate: (prompt: Prompt): Promise<Verdict> => {
      if (stopped) return Promise.reject(new EvaluationError('Scoring was stopped.'));
      if (status.state === 'failed') {
        return Promise.reject(new EvaluationError(status.reason));
      }
      return new Promise<Verdict>((resolve, reject) => {
        const request: EvaluateRequest = {
          type: 'evaluate',
          moveNumber: prompt.moveNumber,
          played: prompt.played,
          ...(prompt.guess === undefined ? {} : { guess: prompt.guess }),
        };
        waiting.set(prompt.moveNumber, { request, resolve, reject });
        // No worker means one died and its replacement waits for a prompt;
        // this is it, and `respawn` asks everything waiting once it is up.
        if (port) port.post(request);
        else void respawn();
      });
    },
  };

  return {
    evaluator,
    status: (): EngineStatus => status,
    deepen: (
      moveNumber: number,
      point: number | null,
      visits: number,
    ): Promise<Deepened | null> => {
      // Never a reason to restart: a longer line is not worth building a
      // worker for, and the next prompt will build one anyway.
      const live: WorkerPort | null = port;
      if (stopped || status.state !== 'ready' || live === null) return Promise.resolve(null);
      // One pass per move at a time. A second request for a move already in
      // flight would orphan the first promise, and the reply carries only a
      // move number to settle it with.
      if (deepening.has(moveNumber)) return Promise.resolve(null);
      return new Promise<Deepened | null>((resolve) => {
        deepening.set(moveNumber, resolve);
        const deepenRequest: WorkerRequest = { type: 'deepen', moveNumber, point, visits };
        live.post(deepenRequest);
      });
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      release();
      failEverything('Scoring was stopped.');
    },
  };
}
