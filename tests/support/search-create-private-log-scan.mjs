import { readFile, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const fail = () => { throw Error('Private create delivery log scan failed.'); };
async function bounded(name, max) {
  try {
    const stat = await lstat(name);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.size < 1 || stat.size > max) fail();
    return await readFile(name, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail();
  }
}
/** Capture only generated marker values before the disposable checkout is removed. */
export async function captureCreatePrivateMarkers(root) {
  try {
    if (path.resolve(root) !== root) fail();
    const sources = [
      ['.env', /^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY)=(.+)$/gm],
      ['.cache/go-camo.env', /^GOCAMO_HMAC=(.+)$/gm],
    ];
    const markers = [];
    for (const [name, pattern] of sources) {
      const value = await bounded(path.join(root, name), 8192);
      if (value !== null) markers.push(...[...value.matchAll(pattern)].map(match => match[1]));
    }
    for (const name of ['verifier.password', 'transition.password']) {
      const value = await bounded(path.join(root, '.cache/search-db/initial-v1', name), 128);
      if (value !== null) markers.push(value.trim());
    }
    const privateKey = await bounded(path.join(root, '.cache/search-security/ca.key'), 16_384);
    if (privateKey !== null) markers.push(privateKey.split('\n')
      .find(line => line.length >= 40)?.slice(0, 32));
    const generation = path.join(root, '.cache/search-generations',
      '11111111111141118111111111111111');
    for (const leaf of ['writer.key', 'query.key']) {
      const key = await bounded(path.join(generation, leaf), 16_384);
      if (key !== null) markers.push(key.split('\n')
        .find(line => line.length >= 40)?.slice(0, 32));
    }
    if (markers.some(marker => typeof marker !== 'string' || marker.length < 16 ||
        marker.length > 8192)) fail();
    return markers;
  } catch { fail(); }
}

/** Scan after all teardown output was captured, even if checkout files are gone. */
export async function scanCreatePrivateLog(root, logName, capturedMarkers) {
  try {
    if (path.resolve(root) !== root || path.resolve(logName) !== logName) fail();
    const log = await bounded(logName, 16 * 1024 * 1024);
    if (log === null || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:POSTGRES_PASSWORD|STATION_MASTER_KEY)=/.test(log)) fail();
    const markers = capturedMarkers ?? await captureCreatePrivateMarkers(root);
    if (!Array.isArray(markers) || markers.length > 16) fail();
    for (const marker of markers) {
      if (typeof marker !== 'string' || marker.length < 16 || marker.length > 8192 ||
          log.includes(marker)) fail();
    }
    return true;
  } catch { fail(); }
}

if (process.argv[1]?.endsWith('/search-create-private-log-scan.mjs')) {
  try {
    if (process.argv.length === 5 && process.argv[2] === '--capture') {
      const markers = await captureCreatePrivateMarkers(path.resolve(process.argv[3]));
      const handle = await open(path.resolve(process.argv[4]), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(markers)); await handle.sync(); }
      finally { await handle.close(); }
    } else if (process.argv.length === 5 && process.argv[2] === '--scan') {
      const name = path.resolve(process.argv[3]);
      const stat = await lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 8192) fail();
      const markers = JSON.parse(await readFile(name, 'utf8'));
      if (!await scanCreatePrivateLog(process.cwd(), path.resolve(process.argv[4]), markers)) fail();
      process.stdout.write('Private create delivery log scan passed.\n');
    } else fail();
  } catch {
    process.stderr.write('Private create delivery log scan failed.\n');
    process.exitCode = 1;
  }
}
