import { ensureSearchGenerationIdentity } from './search-generation-identity.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Expected one generation UUID');
  console.info(JSON.stringify(await ensureSearchGenerationIdentity(process.argv[2])));
} catch {
  console.error('Could not create or verify private generation identity.');
  process.exitCode = 1;
}
