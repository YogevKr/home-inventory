import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AuthEnv = { AUTH_ISSUER: string; AUTH_AUDIENCE: string; DEV_AUTH: string };
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: AuthEnv): Promise<string | null> {
  const url = new URL(request.url);
  if (env.DEV_AUTH === 'true' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return 'Local owner';
  }
  if (!env.AUTH_AUDIENCE || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.AUTH_ISSUER)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    let keys = keySets.get(env.AUTH_ISSUER);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${env.AUTH_ISSUER}/cdn-cgi/access/certs`));
      keySets.set(env.AUTH_ISSUER, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE, algorithms: ['RS256'], requiredClaims: ['exp','iat','sub'],
    });
    if (typeof payload.email === 'string' && payload.email) return payload.email;
    if (typeof payload.common_name === 'string' && payload.common_name) return `Agent: ${payload.common_name}`;
    return null;
  } catch { return null; }
}
