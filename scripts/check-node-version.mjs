import { fileURLToPath } from 'node:url';

export function supportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 22 && (minor > 23 || (minor === 23 && patch >= 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(supportedNodeVersion(process.versions.node) ? 0 : 1);
}
