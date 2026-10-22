import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCompleteSecurityCollections } from './opensearch-generation-collections.mjs';

const role = { cluster_permissions: [], index_permissions: [
  { index_patterns: ['station-mail-v2-g000'], allowed_actions: ['indices:data/read/get'] }], tenant_permissions: [] };
const mapping = { users: ['station-search-query-000'], backend_roles: [], hosts: [] };
const expectedRoles = { generation_query: role };
const expectedMappings = { generation_query: mapping };
const compare = (roles = expectedRoles, mappings = expectedMappings) =>
  assertCompleteSecurityCollections(roles, mappings, expectedRoles, expectedMappings);

test('exact complete collection allows ordering and absent empty defaults', () => {
  compare({ generation_query: { ...role, index_permissions: [
    { allowed_actions: ['indices:data/read/get'], index_patterns: ['station-mail-v2-g000'], fls: [] }] } },
  { generation_query: { ...mapping, and_backend_roles: [] } });
});

test('complete collection rejects unknown names, hidden grants and extra fields', () => {
  for (const roles of [
    { ...expectedRoles, extra: role },
    { generation_query: { ...role, hidden: true } },
    { generation_query: { ...role, extra: false } },
    { generation_query: { ...role, index_permissions: [
      { ...role.index_permissions[0], allowed_actions: ['indices_all'] }] } },
    { generation_query: { ...role, index_permissions: [
      { ...role.index_permissions[0], dls: '{"match_all":{}}' }] } },
    { generation_query: { ...role, index_permissions: [
      { ...role.index_permissions[0], index_patterns: ['*'] }] } },
  ]) assert.throws(() => compare(roles));
  for (const mappings of [
    { ...expectedMappings, extra: mapping },
    { generation_query: { ...mapping, hidden: true } },
    { generation_query: { ...mapping, backend_roles: ['admin'] } },
    { generation_query: { ...mapping, users: ['other'] } },
  ]) assert.throws(() => compare(expectedRoles, mappings));
});
