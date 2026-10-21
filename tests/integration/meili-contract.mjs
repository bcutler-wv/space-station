import assert from 'node:assert/strict';
import { createMeiliClient, bootstrapMeiliEngine, awaitMeiliTask,
  classifyMeiliError, MeiliContractError } from '../../packages/search/dist/meili-transport.js';

const client = createMeiliClient({ host: process.env.MEILI_HOST ?? '', apiKey: process.env.MEILI_MASTER_KEY ?? '' });
const uid = `fake_contract_${Date.now()}`;
const index = client.index(uid);
const scope = 'ownerId = "owner-example" AND accountId = "account-a"';
const docs = [
  { id:'a', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'red apple', body:'quiet canary', sender:'dana@example.com', recipient:'alex@example.com', cc:'team@example.com', filename:['invoice.pdf'], labelIds:['work'], folder:'inbox', kind:'mail', unread:true, starred:false, needsReply:false, hasAttachment:true, sentAt:100 },
  { id:'b', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-home'], subject:'red orange', body:'loud robin', sender:'alex@example.com', recipient:'dana@example.com', cc:'', filename:[], labelIds:['archive'], folder:'sent', kind:'mail', unread:false, starred:true, needsReply:true, hasAttachment:false, sentAt:200 },
  { id:'c', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'green apple', body:'quiet robin', sender:'dana@example.com', recipient:'team@example.com', cc:'alex@example.com', filename:['report.csv'], labelIds:['archive'], folder:'inbox', kind:'mail', unread:true, starred:false, needsReply:false, hasAttachment:true, sentAt:300 },
  { id:'outside-account', ownerId:'owner-example', accountId:'account-b', orbitIds:['orbit-work'], subject:'red apple', body:'quiet canary', sender:'dana@example.com', recipient:'alex@example.com', cc:'', filename:[], labelIds:['work'], folder:'inbox', kind:'mail', unread:true, starred:false, needsReply:false, hasAttachment:false, sentAt:400 },
  { id:'outside-owner', ownerId:'other-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'red apple', body:'quiet canary', sender:'dana@example.com', recipient:'alex@example.com', cc:'', filename:[], labelIds:['work'], folder:'inbox', kind:'mail', unread:true, starred:false, needsReply:false, hasAttachment:false, sentAt:500 },
  { id:'punctuation', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'invoice.pdf', body:'run path\\name', sender:'zoe@example.com', recipient:'', cc:'', filename:['invoice.pdf'], labelIds:['work'], folder:'inbox', kind:'mail', unread:false, starred:false, needsReply:false, hasAttachment:true, sentAt:600 },
  { id:'tokenized', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'invoice-pdf', body:'run path-name', sender:'zoe@example.com', recipient:'', cc:'', filename:[], labelIds:['work'], folder:'inbox', kind:'mail', unread:false, starred:false, needsReply:false, hasAttachment:false, sentAt:700 },
  { id:'first-ten', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'alpha bravo charlie delta echo foxtrot golf hotel india juliet', body:'', sender:'zoe@example.com', recipient:'', cc:'', filename:[], labelIds:[], folder:'inbox', kind:'mail', unread:false, starred:false, needsReply:false, hasAttachment:false, sentAt:800 },
  { id:'all-eleven', ownerId:'owner-example', accountId:'account-a', orbitIds:['orbit-work'], subject:'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo', body:'', sender:'zoe@example.com', recipient:'', cc:'', filename:[], labelIds:[], folder:'inbox', kind:'mail', unread:false, starred:false, needsReply:false, hasAttachment:false, sentAt:900 },
];
const ids = async (q = '', filter = scope, options = {}) => {
  const result = await index.search(q, { filter, matchingStrategy:'all', limit:20, attributesToRetrieve:['id'], ...options });
  assert.ok(result.hits.length <= 20);
  return result.hits.map(hit => hit.id).sort();
};
const exact = async (expected, q = '', filter = scope, options = {}) => assert.deepEqual(await ids(q, filter, options), expected.slice().sort());

try {
  await bootstrapMeiliEngine(client);
  assert.equal((await client.getExperimentalFeatures()).containsFilter, true);
  await awaitMeiliTask(client.createIndex(uid, { primaryKey:'id' }));
  await awaitMeiliTask(index.updateSettings({
    searchableAttributes:['subject','body','sender','recipient','cc','filename'],
    filterableAttributes:['ownerId','accountId','orbitIds','subject','sender','recipient','cc','filename','labelIds','folder','kind','unread','starred','needsReply','hasAttachment','sentAt'],
  }));
  await awaitMeiliTask(index.addDocuments(docs));

  await exact(['a'], 'red apple');
  const relaxed = await ids('red apple', scope, { matchingStrategy:'last' });
  assert.ok(relaxed.includes('b'), 'Default-style last-term relaxation broadens strict AND');
  await exact(['b'], 'red -apple');
  await exact(['b','punctuation','tokenized','first-ten','all-eleven'], '-apple');
  await exact(['b','c','punctuation','tokenized','first-ten','all-eleven'], '-"red apple"');
  await exact(['a'], '"red apple"');
  await exact(['a'], 'red', `${scope} AND sender CONTAINS "ana"`);
  await exact(['a','c'], '', `${scope} AND sender CONTAINS "ana"`);
  await exact(['a'], '', `${scope} AND subject CONTAINS "red apple"`);
  await exact(['a','c'], '', `${scope} AND orbitIds = "orbit-work" AND sender CONTAINS "ana"`);
  await exact(['a'], '', `${scope} AND recipient CONTAINS "alex" AND cc CONTAINS "team"`);
  await exact(['a','punctuation'], '', `${scope} AND filename CONTAINS "invoice.pdf"`);
  await exact(['a','punctuation'], '', `${scope} AND labelIds = "work" AND hasAttachment = true`);
  await exact(['b'], '', `${scope} AND folder = "sent" AND starred = true AND needsReply = true`);
  await exact(['a','c'], '', `${scope} AND folder = "inbox" AND unread = true`);
  await exact(['b','c'], '', `${scope} AND sentAt >= 200 AND sentAt < 400`);
  await exact(['a'], '', `${scope} AND NOT labelIds = "archive" AND hasAttachment = true AND sender CONTAINS "ana"`);
  await exact([], 'red', 'ownerId = "other-example" AND accountId = "account-b"');

  const union = await client.multiSearch({ queries:[
    {indexUid:uid,q:'red',filter:scope,matchingStrategy:'all',attributesToRetrieve:['id']},
    {indexUid:uid,q:'apple',filter:`${scope} AND orbitIds = "orbit-work"`,matchingStrategy:'all',attributesToRetrieve:['id']},
  ], federation:{ limit:20, offset:0 } });
  assert.deepEqual(union.hits.map(hit=>hit.id).sort(), ['a','b','c']);
  assert.equal(union.hits.length, new Set(union.hits.map(hit=>hit.id)).size, 'Same-index OR must deduplicate');
  assert.ok(!union.hits.some(hit=>hit.id.startsWith('outside')), 'Every branch must carry external scope');

  // These are explicit evidence of engine limits. No production AST lowerer is present.
  assert.deepEqual(await ids('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo'), ['all-eleven','first-ten']);
  assert.deepEqual(await ids('"invoice.pdf"'), ['a','punctuation','tokenized']);
  assert.deepEqual(await ids('"path\\name"'), ['punctuation','tokenized']);
  assert.deepEqual(await ids('running'), [], 'Pinned engine does not stem running to run');

  let invalidFilter;
  try { await index.search('', { filter:'notFilterable = 1', limit:1 }); }
  catch (error) { invalidFilter = error; }
  assert.equal(classifyMeiliError(invalidFilter), 'api');
  let failedTask;
  try { await awaitMeiliTask(index.addDocuments([{id:{invalid:'id'}}])); }
  catch (error) { failedTask = error; }
  assert.ok(failedTask instanceof MeiliContractError && failedTask.kind === 'task');

  console.info('Pinned Community engine, SDK, strict matching, filters, federation, async tasks, and known limits verified with fake data.');
} finally {
  try { await awaitMeiliTask(index.delete()); }
  catch { console.error('Could not remove disposable search fixture index.'); process.exitCode = 1; }
}
