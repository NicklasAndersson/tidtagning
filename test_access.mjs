import assert from 'node:assert';
import { verifyAccessJwt } from './src/access.ts';

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function sign(claims, kid = 'k1') {
  const data = `${enc({ alg: 'RS256', kid })}.${enc(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(data))).toString('base64url');
  return `${data}.${sig}`;
}
const opts = { aud: 'AUD', issuer: 'https://t.cloudflareaccess.com' };
const ok = { aud: ['AUD'], iss: opts.issuer, exp: Date.now() / 1000 + 60, email: 'nicklas@wwn.se' };

assert.strictEqual((await verifyAccessJwt(await sign(ok), [jwk], opts))?.email, 'nicklas@wwn.se');
assert.strictEqual(await verifyAccessJwt(await sign({ ...ok, aud: ['annan'] }), [jwk], opts), null);
assert.strictEqual(await verifyAccessJwt(await sign({ ...ok, iss: 'https://x' }), [jwk], opts), null);
assert.strictEqual(await verifyAccessJwt(await sign({ ...ok, exp: 1 }), [jwk], opts), null);
assert.strictEqual(await verifyAccessJwt(await sign(ok, 'okänt'), [jwk], opts), null);
const t = await sign(ok);
assert.strictEqual(await verifyAccessJwt(t.slice(0, -4) + 'AAAA', [jwk], opts), null); // förfalskad signatur
assert.strictEqual(await verifyAccessJwt('skräp', [jwk], opts), null);
console.log('access ok');
