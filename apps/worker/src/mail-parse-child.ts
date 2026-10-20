import PostalMime, { addressParser, type Address, type Email } from 'postal-mime';
import { MAIL_LIMITS, parsedMailSchema, type ParseResult } from '@station/shared';

function addresses(values: Address[] | undefined): Array<{ name: string; address: string }> {
  return (values ?? []).flatMap((value) => value.group ? value.group : [value]).map(({ name, address }) => ({ name, address }));
}

function oneAddress(value: Address | undefined): { name: string; address: string } | null {
  return addresses(value ? [value] : [])[0] ?? null;
}

function normalize(email: Email): ParseResult {
  const senderIdentities = email.headers
    .filter((header) => header.key === 'from' || header.key === 'sender')
    .flatMap((header) => addresses(addressParser(header.value)));
  const lists = {
    replyTo: addresses(email.replyTo), to: addresses(email.to),
    cc: addresses(email.cc), bcc: addresses(email.bcc),
  };
  if (senderIdentities.length + Object.values(lists).reduce((total, list) => total + list.length, 0) > MAIL_LIMITS.recipients ||
      email.attachments.length > MAIL_LIMITS.attachments) throw new Error('limit');
  let decodedBytes = 0;
  const attachments = email.attachments.map((item) => {
    const content = typeof item.content === 'string'
      ? Buffer.from(item.content, item.encoding === 'base64' ? 'base64' : 'utf8')
      : item.content instanceof ArrayBuffer ? Buffer.from(item.content) : Buffer.from(item.content);
    decodedBytes += content.byteLength;
    if (decodedBytes > MAIL_LIMITS.decodedAttachmentBytes) throw new Error('limit');
    return {
      filename: item.filename, mimeType: item.mimeType,
      disposition: item.disposition, contentId: item.contentId ?? null,
      related: item.related ?? false, contentBase64: content.toString('base64'),
    };
  });
  if (Buffer.byteLength(email.text ?? '') + Buffer.byteLength(email.html ?? '') > MAIL_LIMITS.bodyBytes) throw new Error('limit');
  const mail = parsedMailSchema.safeParse({
    subject: email.subject ?? null, messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null, references: email.references ?? null,
    date: email.date ?? null, from: oneAddress(email.from), senderIdentities, ...lists,
    text: email.text ?? null, untrustedHtml: email.html ?? null, attachments,
  });
  if (!mail.success) throw new Error('limit');
  return { ok: true, mail: mail.data };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAIL_LIMITS.rawBytes) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'input_too_large' }));
      return;
    }
    chunks.push(bytes);
  }
  let result: ParseResult;
  try {
    const email = await PostalMime.parse(Buffer.concat(chunks), {
      maxHeadersSize: MAIL_LIMITS.headersBytes, maxPartCount: MAIL_LIMITS.parts,
      maxNestingDepth: MAIL_LIMITS.depth, maxRfc822NestingDepth: MAIL_LIMITS.rfc822Depth,
      maxForwardedAddresses: MAIL_LIMITS.recipients,
    });
    result = normalize(email);
  } catch (error) {
    // PostalMime limit errors carry numeric caps; never expose its raw-message text.
    const message = error instanceof Error ? error.message : '';
    result = { ok: false, code: message === 'limit' || /Maximum .* exceeded/.test(message) ? 'limit_exceeded' : 'malformed' };
  }
  const output = JSON.stringify(result);
  process.stdout.write(Buffer.byteLength(output) <= MAIL_LIMITS.outputBytes
    ? output : JSON.stringify({ ok: false, code: 'limit_exceeded' }));
}

void main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, code: 'malformed' })); });
