import { bootstrapMeiliEngine, classifyMeiliError, createMeiliClient } from './meili-transport.js';

try {
  const client = createMeiliClient({ host: process.env.MEILI_HOST ?? '', apiKey: process.env.MEILI_MASTER_KEY ?? '' });
  await bootstrapMeiliEngine(client);
  console.info('Private search engine ready at pinned version with substring filters enabled.');
} catch (error) {
  console.error(`Private search-engine bootstrap failed (${classifyMeiliError(error)}).`);
  process.exitCode = 1;
}
