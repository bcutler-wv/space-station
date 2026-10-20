import { MAIL_LIMITS, rawMailSchema, parseResultSchema, type ParseResult } from '@station/shared';

// This fixed internal endpoint never accepts a URL from provider or message content.
const PARSER_URL = 'http://mime-parser:8090/parse';

export async function parseMail(raw: Uint8Array, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ParseResult> {
  if (!rawMailSchema.safeParse(raw).success) return { ok: false, code: 'input_too_large' };
  try {
    const response = await fetchImpl(PARSER_URL, {
      method: 'POST', headers: { 'Content-Type': 'message/rfc822' },
      body: Buffer.from(raw), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MAIL_LIMITS.timeoutMs + 2_000)])
        : AbortSignal.timeout(MAIL_LIMITS.timeoutMs + 2_000),
    });
    if (Number(response.headers.get('content-length')) > MAIL_LIMITS.outputBytes) {
      await response.body?.cancel();
      return { ok: false, code: 'limit_exceeded' };
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (!response.body) return { ok: false, code: 'malformed' };
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      bytes += chunk.byteLength;
      if (bytes > MAIL_LIMITS.outputBytes) { await reader.cancel(); return { ok: false, code: 'limit_exceeded' }; }
      chunks.push(Buffer.from(chunk));
    }
    try {
      const parsed = parseResultSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return parsed.success ? parsed.data : { ok: false, code: 'malformed' };
    } catch { return { ok: false, code: 'malformed' }; }
  } catch { return { ok: false, code: 'service_unavailable' }; }
}
