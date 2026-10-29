import type { Identity } from './auth';

/** Example token parser. Production code must verify a cryptographic signature. */
export function validateToken(token: string): Identity {
  if (token.length < 16) throw new Error('Invalid token');
  return { userId: token.slice(0, 12), role: 'member' };
}
