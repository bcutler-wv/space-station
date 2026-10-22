import assert from 'node:assert/strict';

const fields = (value, allowed, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} object`);
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), `${label} unknown field`);
  return value;
};
const strings = (value, label) => {
  assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string'), `${label} strings`);
  assert.equal(new Set(value).size, value.length, `${label} duplicate`);
  return [...value].sort();
};
const empty = (value, expected, label) => {
  if (value !== undefined) assert.deepEqual(value, expected, `${label} default must be empty`);
};
const optionalBoolean = (value, label) => {
  assert.ok(value === undefined || typeof value === 'boolean', `${label} boolean`);
  return value ?? false;
};
const optionalDescription = value => {
  assert.ok(value === undefined || typeof value === 'string', 'description string');
  return value ?? null;
};
const sortedObjects = value => value.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function role(value) {
  const item = fields(value, ['reserved', 'hidden', 'static', 'description',
    'cluster_permissions', 'index_permissions', 'tenant_permissions'], 'role');
  const permissions = item.index_permissions ?? [];
  assert.ok(Array.isArray(permissions), 'index permission list');
  const index = sortedObjects(permissions.map(entry => {
    const p = fields(entry, ['index_patterns', 'allowed_actions', 'dls', 'fls', 'masked_fields'], 'index permission');
    empty(p.dls, '', 'dls'); empty(p.fls, [], 'fls'); empty(p.masked_fields, [], 'masked fields');
    return { index_patterns: strings(p.index_patterns, 'index patterns'),
      allowed_actions: strings(p.allowed_actions, 'index actions') };
  }));
  const tenants = item.tenant_permissions ?? [];
  assert.ok(Array.isArray(tenants), 'tenant permission list');
  const tenant = sortedObjects(tenants.map(entry => {
    const p = fields(entry, ['tenant_patterns', 'allowed_actions'], 'tenant permission');
    return { tenant_patterns: strings(p.tenant_patterns, 'tenant patterns'),
      allowed_actions: strings(p.allowed_actions, 'tenant actions') };
  }));
  return { reserved: optionalBoolean(item.reserved, 'reserved'),
    hidden: optionalBoolean(item.hidden, 'hidden'), static: optionalBoolean(item.static, 'static'),
    description: optionalDescription(item.description),
    cluster_permissions: strings(item.cluster_permissions ?? [], 'cluster permissions'),
    index_permissions: index, tenant_permissions: tenant };
}

function mapping(value) {
  const item = fields(value, ['reserved', 'hidden', 'static', 'description',
    'users', 'backend_roles', 'and_backend_roles', 'hosts'], 'mapping');
  return { reserved: optionalBoolean(item.reserved, 'reserved'),
    hidden: optionalBoolean(item.hidden, 'hidden'), static: optionalBoolean(item.static, 'static'),
    description: optionalDescription(item.description), users: strings(item.users ?? [], 'users'),
    backend_roles: strings(item.backend_roles ?? [], 'backend roles'),
    and_backend_roles: strings(item.and_backend_roles ?? [], 'and backend roles'),
    hosts: strings(item.hosts ?? [], 'hosts') };
}

export function assertCompleteSecurityCollections(actualRoles, actualMappings, expectedRoles, expectedMappings) {
  const compare = (actual, expected, normalize, label) => {
    const observed = fields(actual, Object.keys(expected), `${label} collection`);
    assert.deepEqual(Object.keys(observed).sort(), Object.keys(expected).sort(), `${label} complete names`);
    for (const name of Object.keys(expected))
      assert.deepEqual(normalize(observed[name]), normalize(expected[name]), `${label} ${name} exact grants`);
  };
  compare(actualRoles, expectedRoles, role, 'roles');
  compare(actualMappings, expectedMappings, mapping, 'role mappings');
}
