/* global structuredClone */
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';

const fail = () => { throw Error('Private writer preparation registry fixture failed.'); };
const cases = Object.freeze({
  'registry-revision': Object.freeze({ table: 'search_generation_control',
    trigger: 'search_generation_control_guard_trigger', column: 'revision' }),
  'registry-candidate-uuid': Object.freeze({ table: 'search_generation_control',
    trigger: 'search_generation_control_guard_trigger', column: 'index_uuid' }),
  'create-dispatch-owner': Object.freeze({ table: 'search_generation_dispatch',
    trigger: 'search_generation_dispatch_guard_trigger', column: 'owner_id' }),
});
const changedUuid = 'fixture-changed-candidate-uuid';
const changedOwner = '22222222-2222-4222-8222-222222222222';
const tokenPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const uuidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const guardNames = [
  ['search_generation_control', 'search_generation_control_guard_trigger', 'search_generation_control_guard'],
  ['search_generation_history', 'search_generation_history_guard_trigger', 'search_generation_history_guard'],
  ['search_generation_dispatch', 'search_generation_dispatch_guard_trigger', 'search_generation_dispatch_guard'],
];
const guardPredicate = `n.nspname='public' AND pn.nspname='public' AND
  NOT t.tgisinternal AND t.tgenabled='O' AND (${guardNames.map(([table, trigger, fn]) =>
    `(c.relname='${table}' AND t.tgname='${trigger}' AND p.proname='${fn}')`).join(' OR ')})`;
const guardFrom = `FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
  JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE ${guardPredicate}`;
const guardCheck = `SELECT count(*) ${guardFrom}`;
const currentImage = `jsonb_build_object(
  'control',(SELECT to_jsonb(c) FROM public.search_generation_control c WHERE singleton=1),
  'history',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY generation_token),'[]'::jsonb)
    FROM public.search_generation_history h),
  'dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY generation_token,operation),'[]'::jsonb)
    FROM public.search_generation_dispatch d),
  'microseconds',jsonb_build_object(
    'control',(SELECT to_char(updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM public.search_generation_control WHERE singleton=1),
    'history',(SELECT coalesce(jsonb_agg(jsonb_build_array(generation_token,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY generation_token),'[]'::jsonb) FROM public.search_generation_history),
    'dispatch',(SELECT coalesce(jsonb_agg(jsonb_build_array(generation_token,operation,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY generation_token,operation),'[]'::jsonb) FROM public.search_generation_dispatch)))`;
const hexJson = value => Buffer.from(JSON.stringify(value)).toString('hex');
const sqlJson = value => `convert_from(decode('${hexJson(value)}','hex'),'UTF8')::jsonb`;

function images(name, original) {
  if (!Object.hasOwn(cases, name) || !original ||
      Object.keys(original).sort().join('|') !== 'control|dispatch|history|microseconds' ||
      !original.control || original.control.singleton !== 1 ||
      original.control.stage !== 'uuid_bound' ||
      !Number.isSafeInteger(original.control.revision) ||
      original.control.revision < 1 || original.control.revision >= 2147483647 ||
      !tokenPattern.test(original.control.generation_token) ||
      !uuidPattern.test(original.control.index_uuid) ||
      original.control.index_uuid === changedUuid ||
      !Array.isArray(original.history) || !Array.isArray(original.dispatch) ||
      !original.microseconds ||
      !Array.isArray(original.microseconds.history) ||
      !Array.isArray(original.microseconds.dispatch)) fail();
  canonicalAttestorValue(original, 48 * 1024);
  const candidate = original.history.filter(row =>
    row.generation_token === original.control.generation_token);
  const dispatch = original.dispatch.filter(row =>
    row.generation_token === original.control.generation_token && row.operation === 'create_index');
  if (candidate.length !== 1 || candidate[0].index_uuid !== original.control.index_uuid ||
      candidate[0].lifecycle !== 'bound' || dispatch.length !== 1 ||
      dispatch[0].state !== 'response_confirmed' ||
      !tokenPattern.test(dispatch[0].dispatch_id) ||
      !tokenPattern.test(dispatch[0].owner_id) ||
      dispatch[0].owner_id === changedOwner) fail();
  const altered = structuredClone(original);
  if (name === 'registry-revision') altered.control.revision++;
  else if (name === 'registry-candidate-uuid') altered.control.index_uuid = changedUuid;
  else altered.dispatch[altered.dispatch.findIndex(row =>
    row.generation_token === original.control.generation_token &&
    row.operation === 'create_index' && row.dispatch_id === dispatch[0].dispatch_id)].owner_id = changedOwner;
  return { altered, dispatch: dispatch[0] };
}

function updateSql(name, before, after, dispatch) {
  const token = before.control.generation_token;
  if (name === 'registry-revision') return `UPDATE public.search_generation_control
    SET revision=${after.control.revision} WHERE singleton=1 AND revision=${before.control.revision}`;
  if (name === 'registry-candidate-uuid') return `UPDATE public.search_generation_control
    SET index_uuid='${after.control.index_uuid}' WHERE singleton=1 AND
    generation_token='${token}' AND index_uuid='${before.control.index_uuid}' AND
    revision=${before.control.revision}`;
  return `UPDATE public.search_generation_dispatch SET owner_id='${after.dispatch.find(row =>
    row.generation_token === token && row.operation === 'create_index' &&
    row.dispatch_id === dispatch.dispatch_id).owner_id}' WHERE generation_token='${token}'
    AND operation='create_index' AND dispatch_id='${dispatch.dispatch_id}'
    AND owner_id='${before.dispatch.find(row => row.generation_token === token &&
      row.operation === 'create_index' && row.dispatch_id === dispatch.dispatch_id).owner_id}'`;
}

/** One fixed owner-only transaction. A fault position is available only to local fixture tests. */
export async function changeWriterPrepareRegistryFixture(name, direction, original,
  { runSql, readRegistry, testFault = undefined }) {
  try {
    if (!['mutate', 'restore'].includes(direction) || typeof runSql !== 'function' ||
        typeof readRegistry !== 'function' || testFault !== undefined &&
        (process.env.STATION_WRITER_REGISTRY_FIXTURE_TEST !== '1' ||
          !['after-disable', 'after-update', 'before-commit'].includes(testFault))) fail();
    const { altered, dispatch } = images(name, original);
    const before = direction === 'mutate' ? original : altered;
    const after = direction === 'mutate' ? altered : original;
    const selected = cases[name];
    const fault = position => testFault === position ? 'SELECT 1/0;' : '';
    const statement = `BEGIN;
      SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s';
      SET LOCAL idle_in_transaction_session_timeout='8s';
      LOCK TABLE public.search_generation_control, public.search_generation_history,
        public.search_generation_dispatch IN ACCESS EXCLUSIVE MODE;
      DO $fixture$ BEGIN
        IF (${guardCheck})<>3 OR ${currentImage} IS DISTINCT FROM ${sqlJson(before)} THEN
          RAISE EXCEPTION 'fixture baseline or guard mismatch'; END IF;
      END $fixture$;
      ALTER TABLE public.${selected.table} DISABLE TRIGGER ${selected.trigger};
      ${fault('after-disable')}
      DO $fixture$ DECLARE affected integer; BEGIN
        ${updateSql(name, before, after, dispatch)};
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN RAISE EXCEPTION 'fixture row count'; END IF;
      END $fixture$;
      ${fault('after-update')}
      ALTER TABLE public.${selected.table} ENABLE TRIGGER ${selected.trigger};
      DO $fixture$ BEGIN
        IF (${guardCheck})<>3 OR ${currentImage} IS DISTINCT FROM ${sqlJson(after)} THEN
          RAISE EXCEPTION 'fixture result or guard mismatch'; END IF;
      END $fixture$;
      ${fault('before-commit')}
      COMMIT; SELECT 'fixture-committed';`;
    if (statement.length > 256 * 1024 || await runSql(statement) !== 'fixture-committed') fail();
    if (await runSql(guardCheck) !== '3' ||
        !isDeepStrictEqual(await readRegistry(), after)) fail();
    return after;
  } catch { fail(); }
}
