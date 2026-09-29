// Verifierar Cloudflare Access-JWT (Cf-Access-Jwt-Assertion). Ren funktion + nyckelhämtning, se test_access.mjs.
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64(s)));

export async function verifyAccessJwt(
  token: string, keys: JsonWebKey[], opts: { aud: string; issuer: string; now?: number }
): Promise<{ email?: string } | null> {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  try {
    const header = json(h);
    const jwk = keys.find((k: any) => k.kid === header.kid);
    if (header.alg !== 'RS256' || !jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(sig), new TextEncoder().encode(`${h}.${p}`))) return null;
    const claims = json(p);
    const aud = [].concat(claims.aud);
    if (!aud.includes(opts.aud as never) || claims.iss !== opts.issuer) return null;
    if (!(claims.exp > (opts.now ?? Date.now() / 1000))) return null;
    return { email: claims.email };
  } catch {
    return null;
  }
}

// Access-nycklarna roterar ibland: cacha en timme, hämta om vid okänt kid
let cached: { at: number; keys: JsonWebKey[] } | undefined;
export async function accessKeys(teamDomain: string, kid?: string): Promise<JsonWebKey[]> {
  if (cached && Date.now() - cached.at < 3600_000 && (!kid || cached.keys.some((k: any) => k.kid === kid))) return cached.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access-nycklar kunde inte hämtas (${res.status})`);
  cached = { at: Date.now(), keys: ((await res.json()) as { keys: JsonWebKey[] }).keys };
  return cached.keys;
}
