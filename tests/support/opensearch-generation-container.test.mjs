import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';
import { assertGenerationProofContainer } from '../../scripts/check-generation-proof-container.mjs';

const names = [
  ['station-admin', 'search_admin_certs'],
  ['station-query', 'search_query_certs'],
  ['station-indexer', 'search_indexer_certs'],
];
const mounts = [
  ...names.map(([destination, name]) => ({ Destination: `/run/${destination}`,
    Type: 'volume', Name: `station_${name}`, RW: false })),
  ...[['generation-a', '11111111111141118111111111111111'],
    ['generation-b', '22222222222242228222222222222222']].map(([destination, suffix]) => ({
    Destination: `/run/${destination}`, Type: 'bind',
    Source: `${process.cwd()}/.cache/search-generations/${suffix}`, RW: false })),
];
const container = { Config: { User: '2001:2002', Env: [] }, HostConfig: {
  ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
  PidsLimit: 64, Memory: 268_435_456, NanoCpus: 1_000_000_000, GroupAdd: ['1000'],
}, NetworkSettings: { Networks: { only: {} }, Ports: { '8080/tcp': null } }, Mounts: mounts };
const check = value => assertGenerationProofContainer(value, '2001', '2002');

test('non-1000 host identity and exact private mount whitelist', () => {
  assert.doesNotThrow(() => check(container));
  assert.throws(() => check({ ...container, Config: { ...container.Config, User: '1000:1000' } }));
  assert.throws(() => check({ ...container, Mounts: [...mounts, { Destination: '/run/ca-private', RW: false }] }));
  assert.throws(() => check({ ...container, Mounts: mounts.map(mount => mount.Destination === '/run/generation-a' ?
    { ...mount, Source: `${process.cwd()}/.cache/search-security` } : mount) }));
});
