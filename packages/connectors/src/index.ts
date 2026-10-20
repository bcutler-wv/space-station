export { GoogleMailAuthorization, type GoogleTransport } from './google/index.js';
export { openSecret, sealSecret } from './google/secret-envelope.js';
export { GoogleCredentialService, GoogleCredentialError } from './google/credentials.js';
export { GmailReadAdapter, GmailReadError } from './google/read.js';
export type { GmailProfile, GmailLabelPage, GmailMessagePage, GmailHistoryPage, GmailMessageMetadata, GmailRawMessage } from './google/read.js';
