import { timingSafeEqual } from 'crypto';

export function isApiKeyValid(candidate?: string): boolean {
  const expected = process.env.API_KEY?.trim();
  if (!expected || !candidate) return false;

  const actual = Buffer.from(candidate);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function isLocalAuthBypassAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && !process.env.API_KEY?.trim();
}

export function getApiKeyFromHeaders(headers: Record<string, unknown>): string | undefined {
  const header = headers['x-api-key'];
  if (typeof header === 'string') return header;

  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return undefined;
}
