import assert from 'node:assert/strict';
import {sha256} from './integrity.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Row;};
/** Pair every outcome with exactly one earlier received request. Live browser
 * ownership, causal CDP proof and HMAC authenticity are verified separately. */
export function verifyWebRequestPairs(events:readonly Row[],expected:readonly {kind:string;path:string;body:unknown}[],origin:string):Row[]{
 const outcomes=events.filter(row=>!['service-start','request-received'].includes(String(row.kind)));assert.deepEqual(outcomes.map(row=>row.kind),expected.map(row=>row.kind));
 const ids=new Set<string>(),nonces=new Set<string>(),consumed=new Set<number>();
 for(let index=0;index<outcomes.length;index++){
  const row=outcomes[index]!,proof=object(row.proof),wanted=expected[index]!;assert.equal(proof.method,'POST');assert.equal(proof.url,new URL(wanted.path,origin).href);
  assert.ok(typeof proof.fetchRequestId==='string'&&!ids.has(proof.fetchRequestId));ids.add(proof.fetchRequestId);assert.equal(proof.bodySha256,sha256(JSON.stringify(wanted.body)));
  assert.ok(typeof proof.nonceSha256==='string'&&/^[a-f0-9]{64}$/.test(proof.nonceSha256)&&!nonces.has(proof.nonceSha256),'private request nonce was missing or reused');nonces.add(proof.nonceSha256);
  const matches=events.map((received,position)=>({received,position})).filter(({received})=>received.kind==='request-received'&&received.url===proof.url&&received.bodySha256===proof.bodySha256&&received.nonceSha256===proof.nonceSha256);assert.equal(matches.length,1);
  const position=matches[0]!.position;assert.ok(position<events.indexOf(row),'request outcome precedes its received bytes');assert.ok(!consumed.has(position),'one received request was paired with two outcomes');consumed.add(position);
 }
 assert.equal(events.filter(row=>row.kind==='request-received').length,expected.length);assert.equal(consumed.size,expected.length);return outcomes;
}
