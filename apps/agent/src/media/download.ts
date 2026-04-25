/**
 * Download a media URL (Chatwoot / Meta) into a Buffer for transcription.
 * We don't store these on disk — they live in memory for the duration of the
 * worker job and then get garbage collected.
 */
import { Buffer } from 'node:buffer';
import { request } from 'undici';
import { config } from '../config.js';

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  bytes: number;
}

export async function downloadMedia(url: string, hintMimeType?: string): Promise<DownloadedMedia> {
  const headers: Record<string, string> = {};
  // Chatwoot signed URLs work without auth, but if it's an internal URL we
  // attach the token to be safe.
  if (config.CHATWOOT_BASE_URL && url.startsWith(config.CHATWOOT_BASE_URL) && config.CHATWOOT_API_TOKEN) {
    headers['api_access_token'] = config.CHATWOOT_API_TOKEN;
  }
  const res = await request(url, { method: 'GET', headers, headersTimeout: 15_000, bodyTimeout: 30_000 });
  if (res.statusCode >= 400) {
    throw new Error(`download failed ${res.statusCode}: ${url}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const buffer = Buffer.concat(chunks);
  const headerMime =
    typeof res.headers['content-type'] === 'string' ? res.headers['content-type']!.split(';')[0]!.trim() : undefined;
  const mimeType = headerMime ?? hintMimeType ?? 'application/octet-stream';
  const filename = url.split('/').pop()?.split('?')[0] ?? `media-${Date.now()}`;
  return { buffer, mimeType, filename, bytes: buffer.length };
}
