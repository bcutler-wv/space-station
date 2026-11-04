import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const fullId = /^[0-9a-f]{64}$/;
const projectName = /^stationcreate(?:default|runner)[0-9a-f]{12}$/;

export function writerRolePostgresInspectArgs(id, project) {
  assert.match(id, fullId);
  assert.match(project, projectName);
  const network = `${project}_search_admin_db`;
  return ['container', 'inspect', '--format',
    `{"Id":{{json .Id}},"Created":{{json .Created}},"AdminIP":{{with index .NetworkSettings.Networks "${network}"}}{{json .IPAddress}}{{else}}null{{end}}}`,
    id];
}

export function parseWriterRolePostgresProbe(output, expectedId) {
  assert.equal(typeof output, 'string');
  assert.ok(Buffer.byteLength(output) <= 1024);
  const value = JSON.parse(output);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), ['AdminIP', 'Created', 'Id']);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok('value' in descriptor && descriptor.enumerable);
  }
  assert.match(expectedId, fullId);
  assert.equal(value.Id, expectedId);
  assert.equal(typeof value.Created, 'string');
  assert.ok(value.Created.length > 0 && value.Created.length <= 80);
  assert.equal(typeof value.AdminIP, 'string');
  const octets = value.AdminIP.split('.');
  assert.equal(octets.length, 4);
  assert.ok(octets.every(octet => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255));
  return Object.freeze({ id: value.Id, created: value.Created, adminIp: value.AdminIP });
}

export async function inspectWriterRolePostgres(docker, id, project) {
  return parseWriterRolePostgresProbe(await docker(writerRolePostgresInspectArgs(id, project)), id);
}
