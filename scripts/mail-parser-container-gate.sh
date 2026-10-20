#!/usr/bin/env bash
set -euo pipefail

id="$(docker compose ps -q mime-parser)"
test -n "$id"
gate_diagnostics() {
  local status="$1"
  trap - EXIT
  echo "Parser gate resource diagnostics (exit=$status):" >&2
  docker inspect "$id" --format 'container={{.Id}} restarts={{.RestartCount}} running={{.State.Running}} oom={{.State.OOMKilled}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' >&2 || true
  docker compose exec -T mime-parser sh -c '
    for name in cpu.stat memory.peak memory.events pids.current pids.max; do
      printf "%s:\n" "$name"
      cat "/sys/fs/cgroup/$name"
    done
  ' >&2 || true
  exit "$status"
}
trap 'gate_diagnostics "$?"' EXIT
restart_before="$(docker inspect "$id" --format '{{.RestartCount}}')"
oom_before="$(docker compose exec -T mime-parser cat /sys/fs/cgroup/memory.events | awk '$1=="oom_kill" {print $2}')"
docker compose exec -T mime-parser node -e "require('http').get('http://127.0.0.1:8090/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
network_id="$(docker inspect "$id" --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}')"
test "$(docker network inspect "$network_id" --format '{{.Internal}}')" = true

inspect="$(docker inspect "$id" --format '{{json .HostConfig}}')"
INSPECT_JSON="$inspect" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const host = JSON.parse(process.env.INSPECT_JSON);
assert.equal(host.ReadonlyRootfs, true);
assert.equal(host.Privileged, false);
assert.equal(host.Memory, 536870912);
assert.equal(host.NanoCpus, 1000000000);
assert.equal(host.PidsLimit, 64);
assert.ok(host.CapDrop.includes('ALL'));
assert.ok(host.SecurityOpt.includes('no-new-privileges:true'));
assert.equal(host.Binds?.length ?? 0, 0);
assert.equal(Object.keys(host.PortBindings ?? {}).length, 0);
NODE

docker compose exec -T mime-parser node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (name) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
assert.ok(Number(read('memory.max')) <= 536870912);
assert.ok(Number(read('pids.max')) <= 64);
const [quota, period] = read('cpu.max').split(' ').map(Number);
assert.equal(quota / period, 1);
assert.equal(process.getuid(), 1000);
for (const key of ['STATION_MASTER_KEY', 'POSTGRES_PASSWORD', 'APP_TLS_KEY_PATH']) assert.equal(process.env[key], undefined);
const { parseInChild } = await import('./apps/worker/dist/mail-parser-service.js');
const fixture = Buffer.from('From: fixture@example.com\r\nSubject: cgroup\r\n\r\nbody');
assert.deepEqual(await parseInChild(fixture, 1), { ok: false, code: 'timeout' });
assert.equal((await parseInChild(fixture)).ok, true);
NODE

docker compose exec -T worker node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { parseMail } from './apps/worker/dist/mail-parser-client.js';
const message = Buffer.from('From: fixture@example.com\r\nSubject: fixture\r\n\r\nbody');
const result = await parseMail(message);
assert.equal(result.ok, true);
assert.equal(result.mail.subject, 'fixture');
const concurrent = await Promise.all([parseMail(message), parseMail(message)]);
assert.ok(concurrent.every((item) => item.ok));
const html = Buffer.from('From: fixture@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
  '<p>Safe <a href="https://example.com/read">link</a></p><script>bad()</script>' +
  '<img src="https://example.com/pixel" onload="bad()" alt="Chart">');
const sanitized = await parseMail(html);
assert.equal(sanitized.ok, true, JSON.stringify(sanitized.ok ? {} : sanitized));
assert.equal(sanitized.mail.sanitizedHtml.policyVersion, 1);
assert.doesNotMatch(sanitized.mail.sanitizedHtml.html, /<script|<img|src=|onload=/i);
assert.equal(sanitized.mail.sanitizedHtml.images[0].source, 'https://example.com/pixel');
assert.equal((await parseMail(message)).ok, true);
const bytes = Buffer.alloc(8_000_000, 7);
const base64 = bytes.toString('base64');
const nearHtml = '<table><tr><td>Mail content</td></tr></table>'.repeat(200) + '<img src="https://example.com/near-pixel">';
const nearLimit = Buffer.from('From: fixture@example.com\r\nSubject: near limit\r\nContent-Type: multipart/mixed; boundary="near"\r\n\r\n' +
  '--near\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + nearHtml + '\r\n' +
  '--near\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + base64 + '\r\n--near--');
for (let pair = 1; pair <= 3; pair++) {
  const started = performance.now();
  const largeResults = await Promise.all([parseMail(nearLimit), parseMail(nearLimit)]);
  console.log(`Near-cap mixed parse pair ${pair}: ${Math.round(performance.now() - started)} ms; result codes ${largeResults.map((item) => item.ok ? 'ok' : item.code).join(',')}`);
  for (const item of largeResults) {
    assert.equal(item.ok, true, JSON.stringify(item.ok ? {} : item));
    assert.ok(item.mail.attachments[0].contentBase64 === base64, 'near-cap attachment bytes changed');
    assert.equal(item.mail.sanitizedHtml.images[0].source, 'https://example.com/near-pixel');
  }
  assert.equal((await parseMail(message)).ok, true);
}
assert.equal((await parseMail(Buffer.alloc(12_582_913))).code, 'input_too_large');
assert.equal((await parseMail(message)).ok, true);
NODE

docker compose exec -T mime-parser node -e "require('http').get('http://127.0.0.1:8090/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
test "$(docker inspect "$id" --format '{{.RestartCount}}')" = "$restart_before"
test "$(docker compose ps -q mime-parser)" = "$id"
test "$(docker compose exec -T mime-parser cat /sys/fs/cgroup/memory.events | awk '$1=="oom_kill" {print $2}')" = "$oom_before"

docker compose exec -T app node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
await assert.rejects(dns.lookup('mime-parser'));
NODE

echo 'Mail parser container limits and isolation passed.'
