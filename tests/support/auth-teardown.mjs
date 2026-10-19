import { rm } from 'node:fs/promises';
export default async function authTeardown() {
  await rm('test-results/auth-state.json', { force: true });
  await rm('test-results/auth-fixture.json', { force: true });
}
