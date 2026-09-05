/**
 * What this browser is running on, for the two things that need to know.
 *
 * The setup view, because scoring on a phone is a worse bargain than scoring on
 * a laptop and the user is entitled to know that before paying for the
 * download; and the export, because "which device produced these numbers?" was
 * a question a result could not answer. A dogfood session scored seventy-eight
 * positions wrongly and the only way to establish it had been a phone was to
 * ask the person who played it.
 *
 * No TensorFlow, no DOM beyond `navigator`, so the worker and the main thread
 * can both use it.
 */

/**
 * Whether this is a phone or a tablet.
 *
 * User-agent sniffing, with the client-hint answer preferred where a browser
 * offers it. Both are approximations and one of them is famously wrong: an iPad
 * has claimed to be a Macintosh since iPadOS 13, so a tablet reads as a desktop
 * here. That is the safe direction for the warning this drives — it under-warns
 * rather than nagging a laptop — and the export records what was detected
 * rather than a promise.
 */
export function isMobile(): boolean {
  const hinted = navigator as Navigator & {
    readonly userAgentData?: { readonly mobile?: boolean };
  };
  if (typeof hinted.userAgentData?.mobile === 'boolean') return hinted.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * The GPU as it describes itself, plus whether this is a phone.
 *
 * Deliberately not the user-agent string. This travels into an exported result
 * that a user may hand to someone else, and a full user agent is a fingerprint;
 * "apple / metal-3, mobile" is everything a reader of that file needs and
 * nothing they do not.
 */
export async function describeDevice(): Promise<string> {
  const where: string = isMobile() ? 'mobile' : 'desktop';
  if (!('gpu' in navigator)) return `no WebGPU, ${where}`;

  const adapter: GPUAdapter | null = await navigator.gpu.requestAdapter();
  if (!adapter) return `no adapter, ${where}`;
  /*
   * `info` is the current shape and `requestAdapterInfo()` the older one; which
   * exists depends on the browser, and a phone is the likeliest place to meet
   * the older. Same accommodation the conformance harness makes.
   */
  const either = adapter as GPUAdapter & {
    readonly info?: GPUAdapterInfo;
    readonly requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
  };
  const info: GPUAdapterInfo | undefined = either.info ?? (await either.requestAdapterInfo?.());
  const parts: string[] = [info?.vendor, info?.architecture].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return `${parts.length > 0 ? parts.join(' / ') : 'adapter, no details'}, ${where}`;
}
