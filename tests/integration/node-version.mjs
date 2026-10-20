import assert from 'node:assert/strict';
import { supportedNodeVersion } from '../../scripts/check-node-version.mjs';

for (const version of ['22.23.2', '22.23.3', '22.24.0']) assert.equal(supportedNodeVersion(version), true);
for (const version of ['22.12.0', '22.22.99', '22.23.1', '23.0.0', '24.15.0', 'bad']) {
  assert.equal(supportedNodeVersion(version), false);
}
assert.equal(supportedNodeVersion(process.versions.node), true);
