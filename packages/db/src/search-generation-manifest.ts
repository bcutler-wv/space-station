import type { searchGenerationHistory } from './schema.js';
import { createHash } from 'node:crypto';

type History = typeof searchGenerationHistory.$inferSelect;
const MAX_ROWS = 512;
const MAX_BYTES = 256 * 1024;
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
export type ExpectedGeneration = Readonly<{
  token: string; index: string; profile: string; uuid: string | null;
  presence: 'required' | 'absent' | 'incident_missing_allowed';
  writerRole: string | null; queryRole: string | null;
  writerPrincipal: string | null; queryPrincipal: string | null;
  writerCertFingerprint: string | null; queryCertFingerprint: string | null;
}>;
export type SearchGenerationOperation = 'create_index' | 'writer_role' | 'writer_mapping' | 'query_role' | 'query_mapping';

/** Metadata intent only. An adapter must prove its complete SDK body matches the immutable profile. */
export function searchGenerationDispatchSpec(row: History, operation: SearchGenerationOperation) {
  if (!['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'].includes(operation))
    throw new Error('Unknown search generation operation');
  const [manifest] = buildSearchGenerationManifest([row]);
  if (!manifest) throw new Error('Missing search generation manifest');
  if (manifest.token === 'legacy-v1') throw new Error('Legacy generation has no P2 dispatch');
  const target = operation === 'create_index' ? manifest.index :
    operation.startsWith('writer_') ? manifest.writerRole : manifest.queryRole;
  const principal = operation === 'writer_mapping' ? manifest.writerPrincipal :
    operation === 'query_mapping' ? manifest.queryPrincipal : null;
  if (!target || (operation.endsWith('_mapping') && !principal))
    throw new Error('Incomplete generation dispatch identity');
  const identity = { operation, target, index: manifest.index, profile: manifest.profile,
    principal, actions: operation === 'writer_role' ? ['indices:data/read/get', 'indices:data/write/index'] :
      operation === 'query_role' ? ['indices:data/read/get', 'indices:data/read/search'] : null };
  return { target, bodyIdentity: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}

/** Pure complete-history metadata; staged role presence and full security collection are P2b checks. */
export function buildSearchGenerationManifest(rows: readonly History[]): readonly ExpectedGeneration[] {
  if (rows.length > MAX_ROWS) throw new Error('Search generation manifest row limit');
  const seenToken = new Set<string>(), seenName = new Set<string>();
  const result = rows.map((row): ExpectedGeneration => {
    if (seenToken.has(row.generationToken) || seenName.has(row.physicalIndex))
      throw new Error('Duplicate search generation identity');
    seenToken.add(row.generationToken); seenName.add(row.physicalIndex);
    if (row.generationToken === 'legacy-v1') {
      if (row.physicalIndex !== 'station-mail-v1' || row.profileId !== 'station-mail-v1' ||
          row.writerRole || row.queryRole || row.writerPrincipal || row.queryPrincipal)
        throw new Error('Invalid legacy generation identity');
    } else {
      if (!uuid.test(row.generationToken) || !/^station-mail-v2-g[a-z0-9]{16,64}$/.test(row.physicalIndex) ||
          row.profileId !== 'station-mail-v2') throw new Error('Invalid v2 generation identity');
      const suffix = row.generationToken.replaceAll('-', '').toLowerCase();
      if (row.writerRole !== `station_indexer_${suffix}` || row.queryRole !== `station_query_${suffix}` ||
          row.writerPrincipal !== `station-search-indexer-${suffix}` ||
          row.queryPrincipal !== `station-search-query-${suffix}`)
        throw new Error('Invalid v2 role/principal identity');
    }
    if (row.indexUuid !== null && !engineUuid.test(row.indexUuid))
      throw new Error('Invalid search generation UUID');
    if ([row.writerCertFingerprint, row.queryCertFingerprint].some(value =>
      value !== null && !/^[0-9a-f]{64}$/.test(value)))
      throw new Error('Invalid search generation certificate evidence');
    if (row.generationToken !== 'legacy-v1' &&
        ['roles_attested', 'retired_retained'].includes(row.lifecycle) &&
        (!row.writerCertFingerprint || !row.queryCertFingerprint))
      throw new Error('Missing attested generation certificate evidence');
    const presence = row.lifecycle === 'reserved' || row.lifecycle === 'abandoned' ? 'absent' :
      row.lifecycle === 'unavailable' ? 'incident_missing_allowed' : 'required';
    if (!['reserved', 'bound', 'roles_attested', 'retired_retained', 'abandoned', 'unavailable'].includes(row.lifecycle) ||
        (presence === 'required' && row.indexUuid === null) ||
        (row.lifecycle === 'reserved' && row.indexUuid !== null))
      throw new Error('Invalid search generation lifecycle');
    return { token: row.generationToken, index: row.physicalIndex, profile: row.profileId,
      uuid: row.indexUuid, presence, writerRole: row.writerRole, queryRole: row.queryRole,
      writerPrincipal: row.writerPrincipal, queryPrincipal: row.queryPrincipal,
      writerCertFingerprint: row.writerCertFingerprint,
      queryCertFingerprint: row.queryCertFingerprint };
  }).sort((a, b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES)
    throw new Error('Search generation manifest byte limit');
  return result;
}
