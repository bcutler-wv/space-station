import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw Error('artifact root required');
const read = async name => readFile(join(root, name), 'utf8').catch(() => '');
function bytes(input) {
  const match = /^([0-9.]+)(B|KiB|MiB|GiB|TiB)$/.exec(input);
  if (!match) return null;
  return Math.round(Number(match[1]) * 1024 ** ['B', 'KiB', 'MiB', 'GiB', 'TiB'].indexOf(match[2]));
}
const samples = (await read('stats.jsonl')).split('\n').filter(Boolean).slice(0, 600);
let peak = 0;
for (const line of samples) {
  try {
    const parsed = JSON.parse(line);
    const memory = bytes(String(parsed.MemUsage ?? '').split(' / ')[0]);
    if (memory !== null) peak = Math.max(peak, memory);
  } catch { /* One interrupted Docker sample does not erase valid samples. */ }
}
const resultText = await read('results.json');
const result = resultText ? JSON.parse(resultText) : null;
const processSamples = (await read('process-rss.jsonl')).split('\n').filter(Boolean).slice(0, 600)
  .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
  .filter(item => Number.isSafeInteger(item.rssBytes) && item.rssBytes > 0);
if (result?.status === 'pass' && processSamples.length === 0) throw Error('Java process RSS unavailable');
const summary = {
  imageSizeBytes: Number((await read('image-size-bytes.txt')).trim()) || null,
  imagePullBytes: Number((await read('image-pull-bytes.txt')).trim()) || null,
  containerMemoryPeakBytes: peak || null,
  containerSamples: samples.length,
  processRssSamples: processSamples.length,
  processRssFirstBytes: processSamples[0]?.rssBytes ?? null,
  processRssLastBytes: processSamples.at(-1)?.rssBytes ?? null,
  processRssPeakBytes: processSamples.length ? Math.max(...processSamples.map(item => item.rssBytes)) : null,
  coldReadinessMs: result?.metrics?.coldReadinessMs ?? null,
  coldNode: result?.metrics?.coldNode ?? null,
  indexedNode: result?.metrics?.indexedNode ?? null,
  warmNode: result?.metrics?.warmNode ?? null,
  latency: Object.fromEntries(['ordinary', 'boolean', 'substring', 'multilingual']
    .map(name => [name, result?.metrics?.[name] ?? null])),
  fixtureStatus: result?.status ?? 'missing',
};
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log('OpenSearch proof summary written.');
