/**
 * A game record carried in the URL fragment, gzipped and base64url-encoded.
 *
 *   encode(sgf)      → Promise<string>   the fragment, without the '#'
 *   decode(fragment) → Promise<string>   the SGF it was made from
 *
 * Ported from `kifu`, where the encoding is already proven — see
 * `docs/reuse-notes.md` for what changed on the way across.
 *
 * The fragment is the point. It is never sent to the server, so a link
 * carrying a game reaches the recipient's browser without the record ever
 * appearing in a host's logs. That is a stronger privacy property than
 * mailing the file, and it is why this is worth doing rather than serving
 * records from somewhere.
 *
 * Both directions validate by parsing. Encoding something unparseable would
 * produce a link that fails on someone else's machine, which is the worst
 * place to find out.
 */

import { parse, MAX_BYTES } from './sgf-parser.ts';

export async function encode(sgf: string): Promise<string> {
  parse(sgf);
  return toBase64Url(await gzip(new TextEncoder().encode(sgf)));
}

export async function decode(fragment: string, maxBytes: number = MAX_BYTES): Promise<string> {
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = fromBase64Url(fragment);
  } catch {
    throw new Error('That link is damaged — its game data is not valid base64url.');
  }
  const sgf: string = new TextDecoder().decode(await gunzip(compressed, maxBytes));
  parse(sgf);
  return sgf;
}

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip');
  // The stream's writable side is typed `BufferSource`, so the writer is too;
  // the byte arrays are pinned to `ArrayBuffer` so no cast is needed to feed it.
  const writer: WritableStreamDefaultWriter<BufferSource> = stream.writable.getWriter();
  // Fire-and-forget. Awaiting the write before a reader exists deadlocks once
  // the stream's internal buffer fills.
  void writer.write(data).then(() => writer.close());
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * Decompress, refusing to keep going past `maxBytes`.
 *
 * The limit is checked while reading rather than afterwards because that is
 * the only point where it helps: a few hundred bytes of gzip can expand to
 * gigabytes, and a decoder that learns the size once it has the whole thing
 * has already run out of memory.
 */
async function gunzip(data: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  const writer: WritableStreamDefaultWriter<BufferSource> = stream.writable.getWriter();
  // Cancelling the read below rejects these, and that rejection is expected.
  void writer.write(data).then(() => writer.close()).catch(() => {});

  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`That link holds more than ${maxBytes} bytes of game data.`);
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('That link holds')) throw error;
    throw new Error('That link is damaged — its game data could not be decompressed.');
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64: string = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded: string = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary: string = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
