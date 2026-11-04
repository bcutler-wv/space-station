import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { stageWriterRoleApplyOverride } from '../../scripts/search-writer-role-apply-override.mjs';
import { fixedWriterRoleApplyCommand, verifyWriterRoleApplyMergedConfig } from
  '../../scripts/search-writer-role-apply-service-config.mjs';

const repository = path.resolve(process.argv[3]);
const project = 'writer_apply_fixture';
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const suffix = invocationId.replaceAll('-', '');
const approvedFields = ['a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
  'legacy-v1', 'station-mail-v1', 'legacy_uuid',
  '11111111-1111-4111-8111-111111111111',
  'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
  invocationId, project, '16384', '123'];
const expected = { repository, project, invocationId, approvedFields,
  publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
  volumeName: `${project}_search_writer_apply_${suffix}`,
  transferName: `station_writer_transfer_${suffix}`,
  applyName: `station_writer_apply_${suffix}` };
try {
  if (process.argv[2] === 'write') {
    const item = await stageWriterRoleApplyOverride({ repository,
      uid: process.getuid(), gid: process.getgid(), invocationId,
      transferName: expected.transferName, applyName: expected.applyName,
      transferCommand: ['node', 'scripts/search-writer-role-apply-transfer.mjs'],
      applyCommand: fixedWriterRoleApplyCommand(approvedFields) });
    await item.recheck();
    process.stdout.write(`${item.file}\n`);
  } else {
    assert.equal(process.argv[2], 'check');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; assert.ok(size <= 256 * 1024); chunks.push(chunk);
    }
    assert.equal(verifyWriterRoleApplyMergedConfig(
      JSON.parse(Buffer.concat(chunks).toString('utf8')), expected), true);
    process.stdout.write('Fixed writer role apply merged override passed.\n');
  }
} catch {
  process.stderr.write('Fixed writer role apply merged override failed.\n');
  process.exitCode = 1;
}
