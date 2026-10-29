import { validateToken } from './tokens';
import { Logger } from './logger';

/** Verifies the bearer token before a request reaches application handlers. */
export function authenticate(request: Request) {
  const token = request.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new Error('Authentication required');
  const identity = validateToken(token);
  new Logger('auth').info('Authenticated request');
  return identity;
}

export interface Identity { userId: string; role: 'member' | 'admin'; }
