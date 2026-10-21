import { createHash, randomBytes } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Readable } from 'node:stream';

export const MAX_MIME_BYTES = 12 * 1024 * 1024;
export type Address = { address: string; name: string };
export type FrozenAttachment = { filename: string; bytes: Buffer };
export type MimeInput = {
  from: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string;
  messageId: string; date: Date; inReplyTo?: string; references?: string;
  attachments: FrozenAttachment[];
};

/** Stream into a strict cap; the resulting bytes are published once and never rebuilt. */
export async function composeMime(input: MimeInput): Promise<{ bytes: Buffer; digest: string }> {
  const composer = new MailComposer({
    from: { address: input.from }, to: input.to, cc: input.cc, bcc: input.bcc,
    subject: input.subject, text: input.body, messageId: input.messageId, date: input.date,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references ? { references: input.references } : {}),
    attachments: input.attachments.map(({ filename, bytes }) => ({ filename, content: bytes,
      contentType: 'application/octet-stream', contentDisposition: 'attachment' })),
    disableFileAccess: true, disableUrlAccess: true,
    baseBoundary: randomBytes(16).toString('hex'), boundaryPrefix: 'station', newline: 'win',
  });
  const compiled = composer.compile();
  // Gmail routes from raw To/Cc/Bcc headers. SMTP has different envelope rules.
  compiled.keepBcc = true;
  const stream = compiled.createReadStream() as Readable;
  const timer = setTimeout(() => stream.destroy(new Error('MIME preparation timed out')), 30_000);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      size += chunk.byteLength;
      if (size > MAX_MIME_BYTES) {
        stream.destroy(new Error('MIME exceeds 12 MiB'));
        throw new Error('MIME exceeds 12 MiB');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { clearTimeout(timer); stream.destroy(); }
}
