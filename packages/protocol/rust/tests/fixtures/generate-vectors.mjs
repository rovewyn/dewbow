// Synthetic, public conformance records. No real identity or key material.
// Independent Node.js crypto/JCS oracle; protocol objects contain no floats.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const nonce = byte => Buffer.alloc(32, byte).toString('base64url');
const keyFor = seedByte => createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte),
]) });
const signingBytesFor = (label, body) => Buffer.from(`dewbow.network.${label}.v1\0${canonical(body)}`);
const digest = (label, body) => createHash('sha256').update(signingBytesFor(label, body)).digest('base64url');
function signedRecord(body, key) {
  const label = body.kind === 'createNetwork' ? 'genesis' : 'change';
  const signingBytes = signingBytesFor(label, body);
  const recordId = digest(label, body);
  const signature = sign(null, signingBytes, key).toString('base64url');
  return { body, canonicalBody: canonical(body), signingBytesHex: signingBytes.toString('hex'), recordId,
    signature, canonicalEnvelope: canonical({ recordId, body, signature }) };
}
const vectors = ['Workspace "alpha"\n中文 🚀', '\u00e9', 'e\u0301'].map((networkName, index) => {
  const seedByte = index + 1;
  const key = keyFor(seedByte);
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const body = { protocolVersion: 1, kind: 'createNetwork', nonce: Buffer.alloc(32, seedByte + 10).toString('base64url'),
    networkName, hostId: `00000000-0000-4000-8000-${seedByte.toString().padStart(12, '0')}`, publicKey };
  return { seedByte, ...signedRecord(body, key) };
});
const root = vectors[0];
const networkId = root.recordId;
function snapshot(records) {
  const recordIds = records.map(record => record.recordId).sort((a, b) => Buffer.compare(Buffer.from(a, 'base64url'), Buffer.from(b, 'base64url')));
  const parents = new Set(records.flatMap(record => record.body.parents ?? []));
  return { historyId: digest('history', { protocolVersion: 1, networkId, recordIds }),
    frontier: recordIds.filter(id => !parents.has(id)), recordCount: recordIds.length };
}
const initial = snapshot([root]);
const joinBody = { protocolVersion: 1, networkId, issuerMembershipId: root.recordId,
  invitationId: nonce(20), invitationHistoryId: initial.historyId, invitationFrontier: initial.frontier,
  joinAttemptId: nonce(21), hostId: vectors[1].body.hostId, publicKey: vectors[1].body.publicKey };
const joinProof = { body: joinBody, signature: sign(null, signingBytesFor('join', joinBody), keyFor(2)).toString('base64url') };
const admitted = signedRecord({ protocolVersion: 1, networkId, kind: 'admitMember', operationId: nonce(22),
  authorMembershipId: root.recordId, parents: initial.frontier, payload: { joinProof } }, keyFor(1));
const joined = snapshot([root, admitted]);
const removed = signedRecord({ protocolVersion: 1, networkId, kind: 'removeMember', operationId: nonce(23),
  authorMembershipId: root.recordId, parents: joined.frontier, payload: { membershipId: admitted.recordId } }, keyFor(1));
const departed = signedRecord({ protocolVersion: 1, networkId, kind: 'leaveNetwork', operationId: nonce(24),
  authorMembershipId: admitted.recordId, parents: joined.frontier, payload: { membershipId: admitted.recordId } }, keyFor(2));
const rebaseId = digest('departureRebase', { networkId, membershipId: admitted.recordId,
  operationId: departed.body.operationId, historyId: joined.historyId });
const rebasedDeparture = signedRecord({ ...departed.body, operationId: rebaseId }, keyFor(2));
const membershipScenario = { records: [root, admitted, removed, departed], snapshots: {
  initial, joined, removed: snapshot([root, admitted, removed]), departed: snapshot([root, admitted, departed]),
  combined: snapshot([root, admitted, removed, departed]),
}, rebasedDeparture };
writeFileSync(new URL('network-v1.json', import.meta.url), `${JSON.stringify({ generator: 'Node.js crypto Ed25519; protocol v1 JCS subset', vectors, membershipScenario }, null, 2)}\n`);
