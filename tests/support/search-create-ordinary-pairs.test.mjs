import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const selector = path.join(here, 'search-create-ordinary-pairs.sh');
const gate = path.resolve(here, '../../scripts/search-create-boundary-delivery-gate.sh');
const fixedFailure = 'Create boundary delivery gate has an invalid ordinary pair selection.\n';
const mappingFailure = 'Create boundary delivery gate has an invalid mapping-preparation selection.\n';

function selected(pair, writer = '', delivery = '', deliveryPair = '') {
  return spawnSync('bash', ['-c',
    'source "$1"; select_create_ordinary_pairs "$2" "$3" "$4" "$5" || exit 19; printf "%s\n" "${ordinary_pairs[@]}"',
    '_', selector, pair, writer, delivery, deliveryPair], { encoding: 'utf8' });
}

test('fixed ordinary selector preserves old two-pair mode and selects exactly one pair', () => {
  for (const [pair, writer, expected] of [
    ['', '', 'default\nrunner\n'],
    ['', 'runner-volume', 'default\nrunner\n'],
    ['default', '', 'default\n'],
    ['runner', '', 'runner\n'],
  ]) {
    const result = selected(pair, writer);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, '');
  }
  for (const args of [
    ['other'], ['default runner'], ['DEFAULT'], ['default', 'runner'],
    ['runner', '', 'positive', 'runner'], ['runner', '', '', 'runner'],
  ]) {
    const result = selected(...args);
    assert.equal(result.status, 19, args.join(':'));
    assert.equal(result.stdout, '');
  }
});

test('mixed ordinary and writer selectors fail in the gate before Docker or fixture creation', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/create-pair-select-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'tests/support'), { recursive: true });
  await copyFile(selector, path.join(root, 'tests/support/search-create-ordinary-pairs.sh'));
  for (const fields of [
    { STATION_CREATE_GATE_PAIR: 'neither' },
    { STATION_CREATE_GATE_PAIR: 'default', STATION_WRITER_PREPARE_GATE_VARIANT: 'runner' },
    { STATION_CREATE_GATE_PAIR: 'runner', STATION_WRITER_DELIVERY_GATE_CASE: 'positive' },
    { STATION_CREATE_GATE_PAIR: 'runner', STATION_WRITER_DELIVERY_GATE_PAIR: 'runner' },
  ]) {
    const env = { ...process.env };
    for (const key of ['STATION_CREATE_GATE_PAIR', 'STATION_WRITER_PREPARE_GATE_VARIANT',
      'STATION_WRITER_DELIVERY_GATE_CASE', 'STATION_WRITER_DELIVERY_GATE_PAIR'])
      delete env[key];
    Object.assign(env, fields);
    const result = spawnSync('bash', [gate], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(fields));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, fixedFailure);
  }
});

test('mapping selector chooses one pair and rejects mixed authority before Docker', async t => {
  for (const [mode, pair] of [['positive', 'default'], ['measured', 'runner']]) {
    const selected = spawnSync('bash', ['-c',
      'source "$1"; select_writer_mapping_prepare_pair "$2" "$3" "" "" "" "" || exit 19; printf "%s\\n" "${mapping_pairs[@]}"',
      '_', selector, mode, pair], { encoding: 'utf8' });
    assert.equal(selected.status, 0);
    assert.equal(selected.stdout, `${pair}\n`);
  }
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/mapping-pair-select-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'tests/support'), { recursive: true });
  await copyFile(selector, path.join(root, 'tests/support/search-create-ordinary-pairs.sh'));
  for (const fields of [
    { STATION_WRITER_MAPPING_PREPARE_GATE_CASE: 'positive' },
    { STATION_WRITER_MAPPING_PREPARE_GATE_PAIR: 'runner' },
    { STATION_WRITER_MAPPING_PREPARE_GATE_CASE: 'wrong',
      STATION_WRITER_MAPPING_PREPARE_GATE_PAIR: 'default' },
    { STATION_WRITER_MAPPING_PREPARE_GATE_CASE: 'measured',
      STATION_WRITER_MAPPING_PREPARE_GATE_PAIR: 'runner', STATION_CREATE_GATE_PAIR: 'runner' },
    { STATION_WRITER_MAPPING_PREPARE_GATE_CASE: 'positive',
      STATION_WRITER_MAPPING_PREPARE_GATE_PAIR: 'default',
      STATION_WRITER_DELIVERY_GATE_CASE: 'positive' },
  ]) {
    const env = { ...process.env };
    for (const key of ['STATION_CREATE_GATE_PAIR', 'STATION_WRITER_PREPARE_GATE_VARIANT',
      'STATION_WRITER_DELIVERY_GATE_CASE', 'STATION_WRITER_DELIVERY_GATE_PAIR',
      'STATION_WRITER_MAPPING_PREPARE_GATE_CASE', 'STATION_WRITER_MAPPING_PREPARE_GATE_PAIR'])
      delete env[key];
    Object.assign(env, fields);
    const result = spawnSync('bash', [gate], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(fields));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, mappingFailure);
  }
  const env = { ...process.env,
    STATION_WRITER_MAPPING_PREPARE_GATE_CASE: 'positive',
    STATION_WRITER_MAPPING_PREPARE_GATE_PAIR: 'default' };
  for (const key of ['STATION_CREATE_GATE_PAIR', 'STATION_WRITER_PREPARE_GATE_VARIANT',
    'STATION_WRITER_DELIVERY_GATE_CASE', 'STATION_WRITER_DELIVERY_GATE_PAIR'])
    delete env[key];
  const accepted = spawnSync('bash', [gate], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(accepted.status, 0);
  assert.doesNotMatch(accepted.stderr, /invalid .*selection|invalid writer-delivery pair/);
});
