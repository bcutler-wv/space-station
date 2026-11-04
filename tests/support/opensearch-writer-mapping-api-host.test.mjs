import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { runWriterMappingApiHost } from './opensearch-writer-mapping-api-host.mjs';

const id = 'a'.repeat(64);
const name = 'station-mapping-api-proof-111111111111';
const secret = 'generated-secret-password-value';
const first = 'Writer mapping API shape phase=first http=201 schema=status-message keys=2 status=CREATED message=quoted-target-created bytes=92 producer=1 connection=1';
const replacement = 'Writer mapping API shape phase=replacement http=200 schema=status-message keys=2 status=OK message=quoted-target-updated bytes=91 producer=1 connection=1';
const ambiguous = 'Writer mapping API shape phase=ambiguous-first http=201 schema=status-message keys=2 status=CREATED message=quoted-target-created bytes=92 producer=1 connection=1';
const observed = 'Writer mapping API shape phase=ambiguous original-return-lost observed-mapping=true producer=1 connection=1';
const proof = [first, replacement, ambiguous, observed,
  'Writer mapping API versions opensearch=3.9.0 sdk=3.9.0',
  'Writer mapping API plugin security=3.9.0.0 nodes=1',
  'Pinned writer mapping API proof passed.'].join('\n') + '\n';
const response = (code, stdout = '', stderr = '') =>
  ({ code, stdout, stderr, failed: false });

async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-mapping-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.cache/search-security'), { recursive: true });
  await writeFile(path.join(root, '.env'), `POSTGRES_PASSWORD=${secret}\n`);
  for (const role of ['ca', 'node', 'admin', 'query', 'indexer', 'outsider'])
    await writeFile(path.join(root, '.cache/search-security', `${role}.key`),
      `${role.repeat(24)}\n`);
  return root;
}
function commandRig({ effect = 'success', raw = proof, root }) {
  const calls = [];
  let removed = false;
  const command = async (program, args) => {
    assert.equal(program, 'docker');
    calls.push(args);
    const joined = args.join(' ');
    if (joined.startsWith('version '))
      return effect === 'version-timeout' ?
        { code: null, stdout: 'partial version\n', stderr: 'bounded timeout\n',
          failed: true } : response(0, '28.5.1 1.51\n');
    if (joined === 'compose version --short') return response(0, 'v2.40.3\n');
    if (joined === `container inspect --format {{.Id}} ${name}`)
      return response(effect === 'preexisting' ? 0 : 1,
        effect === 'preexisting' ? `${id}\n` : '');
    if (joined.includes(' run -d ')) {
      assert.ok(args.includes('-p'));
      assert.equal(args[args.indexOf('-p') + 1], path.basename(root).toLowerCase());
      assert.deepEqual(args.slice(-4), [name, 'search-profile-drift', 'node',
        'tests/integration/opensearch-writer-mapping-api-proof.mjs']);
      return response(0, `${id}\n`);
    }
    if (joined.startsWith('inspect --format '))
      return response(0, `${JSON.stringify(id)} ${JSON.stringify(`/${name}`)} ` +
        '{"com.docker.compose.service":"search-profile-drift",' +
        `"com.docker.compose.project":"${effect === 'wrong-ownership' ? 'other' :
          path.basename(root).toLowerCase()}"}\n`);
    if (joined === `wait ${id}`) {
      if (effect === 'wait-timeout' || effect === 'wait-timeout-secret')
        return { code: null, stdout: 'partial wait output\n',
          stderr: effect === 'wait-timeout-secret' ? `${secret}\n` : 'bounded timeout\n',
          failed: true };
      return response(0,
        effect === 'wait-failure' || effect === 'wait-and-cleanup-failure' ?
          '1\n' : '0\n');
    }
    if (joined === `logs ${id}`) return response(0, raw);
    if (joined === `rm ${id}`) {
      if (effect === 'missing-log')
        await rm(path.join(root, '.cache/results/writer-mapping-api-private.log'));
      if (effect === 'cleanup-failure' || effect === 'wait-and-cleanup-failure')
        return response(1, '', 'private cleanup error');
      removed = true;
      return response(0, `${id}\n`);
    }
    if (joined === `container inspect --format {{.Id}} ${id}`)
      return response(removed ? 1 : 0, removed ? '' : `${id}\n`);
    throw Error('Unexpected fixed command');
  };
  return { command, calls };
}

test('fixed host sequence forwards only finite proof and checked versions after owned cleanup and scan', async t => {
  const root = await fixture(t);
  const rig = commandRig({ root });
  const result = await runWriterMappingApiHost({ root, command: rig.command,
    nonce: '111111111111', uid: 1001 });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, `${proof}Writer mapping API host docker=28.5.1 ` +
    'api=1.51 compose=v2.40.3 uid=1001\n');
  assert.equal(rig.calls.filter(args => args[0] === 'rm').length, 1);
  assert.equal(rig.calls.filter(args => args[0] === 'container' && args.at(-1) === id)
    .length, 1);
  assert.ok((await readFile(path.join(root,
    '.cache/results/writer-mapping-api-private.log'), 'utf8')).includes(proof));
});

test('all failure paths retain finite status and scan private output before forwarding', async t => {
  for (const [effect, raw, expectedPhase, removes] of [
    ['version-timeout', proof, 'versions', 0],
    ['preexisting', proof, 'absence', 0],
    ['wrong-ownership', proof, 'ownership', 0],
    ['wait-failure', proof, 'wait', 1],
    ['wait-and-cleanup-failure', proof, 'wait', 1],
    ['wait-timeout', proof, 'wait', 1],
    ['wait-timeout-secret', proof, 'wait', 1],
    ['cleanup-failure', proof, 'cleanup', 1],
    ['secret', `${proof}${secret}\n`, 'scan', 1],
    ['unknown', proof.replace('http=201', 'http=other'), 'proof-output', 1],
    ['missing-log', proof, 'scan', 1],
  ]) {
    const root = await fixture(t);
    const rig = commandRig({ effect, raw, root });
    const result = await runWriterMappingApiHost({ root, command: rig.command,
      nonce: '111111111111', uid: 1001 });
    assert.equal(result.code, 1, effect);
    assert.match(result.output, new RegExp(`failed at ${expectedPhase}; scan=`), effect);
    assert.equal(result.output.includes(secret), false);
    assert.equal(result.output.includes(id), false);
    assert.equal(result.output.includes(raw), false);
    if (effect === 'cleanup-failure' || effect === 'wait-and-cleanup-failure')
      assert.equal(result.output.includes('Writer mapping API shape'), false);
    assert.equal(rig.calls.filter(args => args[0] === 'rm').length, removes, effect);
    if (effect === 'secret' || effect === 'missing-log' ||
        effect === 'wait-timeout-secret')
      assert.match(result.output, /scan=private-failed/);
    else assert.match(result.output, /scan=complete/);
    if (effect === 'wait-timeout' || effect === 'wait-timeout-secret') {
      assert.equal(rig.calls.filter(args => args[0] === 'logs').length, 1);
      if (effect === 'wait-timeout-secret')
        assert.equal(result.output.includes('Writer mapping API shape'), false);
    }
  }
});
