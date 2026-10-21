export { GoogleMailAuthorization, GMAIL_MODIFY_SCOPE, type GoogleTransport } from './google/index.js';
export { openSecret, sealSecret } from './google/secret-envelope.js';
export { GoogleCredentialService, GoogleCredentialError } from './google/credentials.js';
export { GmailReadAdapter, GmailReadError } from './google/read.js';
export { GmailSendAdapter, GmailSendError, type SentEvidence } from './google/send.js';
export type { GmailProfile, GmailLabelPage, GmailMessagePage, GmailHistoryPage, GmailMessageMetadata, GmailRawMessage } from './google/read.js';
