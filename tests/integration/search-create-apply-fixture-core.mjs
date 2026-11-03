// Disposable-image-only wrapper. The original consumer owns every CAS and
// every evidence decision; this module observes finite reached boundaries.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { runCreateApplyConsumer as original } from './search-create-apply-consumer-core-original.mjs';

const mode = readFileSync('/app/create-apply-fixture-mode', 'utf8');
const marker = name => process.stderr.write(`CREATE_APPLY_FIXTURE:${name}\n`);
async function hold(name) {
  const label = name.toUpperCase().replaceAll('-', '_');
  marker(`${label}_HELD`);
  writeFileSync(`/tmp/create-apply-${name}-held`, '1', { mode: 0o600, flag: 'wx' });
  for (let tick = 0; tick < 300; tick++) {
    if (existsSync(`/tmp/create-apply-${name}-release`)) {
      marker(`${label}_RELEASED`); return;
    }
    await delay(100);
  }
  throw Error('Fixture controller did not release finite hold');
}

export async function runCreateApplyConsumer(deps) {
  let createCalls = 0;
  return original({ ...deps,
    advance: async (...args) => {
      const result = await deps.advance(...args);
      marker(`ADVANCE_${args[1].toUpperCase()}`);
      return result;
    },
    arm: async (...args) => {
      const result = await deps.arm(...args);
      marker('ARMED');
      if (mode === 'crash-before-sent') process.exit(42);
      return result;
    },
    dispatch: async (...args) => {
      const result = await deps.dispatch(...args);
      marker(`DISPATCH_${args[1].state.toUpperCase()}`);
      if (args[1].state === 'sent_unknown' && mode === 'crash-after-sent') process.exit(42);
      if (args[1].state === 'response_confirmed' && mode === 'db-after-confirm')
        await hold('after-confirm');
      return result;
    },
    createOnce: async (...args) => {
      assert.equal(++createCalls, 1);
      const snapshot = await deps.readSnapshot();
      const input = await deps.readInput();
      const dispatch = snapshot.dispatch.find(row => row.generationToken ===
        input.intent.candidateToken && row.operation === 'create_index');
      assert.equal(snapshot.control.revision, input.intent.revision + 3);
      assert.equal(snapshot.control.stage, 'create_requested');
      assert.equal(dispatch?.state, 'sent_unknown');
      assert.equal(dispatch?.dispatchId, input.intent.dispatchId);
      assert.equal(dispatch?.ownerId, input.intent.ownerId);
      assert.equal(dispatch?.target, input.intent.target);
      assert.equal(dispatch?.bodyIdentity, input.intent.bodyIdentity);
      marker('PRESEND_DB_CONFIRMED');
      if (mode === 'concurrent-hold') await hold('presend');
      const result = await deps.createOnce(...args);
      marker('SDK_READBACK_RETURNED');
      if (mode === 'crash-after-readback') process.exit(42);
      if (mode === 'db-after-engine') await hold('after-engine');
      return result;
    },
  });
}
