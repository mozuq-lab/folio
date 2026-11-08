import { AsyncLocalStorage } from 'node:async_hooks';

export type AuthUser = { id: string; email: string; displayName: string };

// The Worker entry stores the verified user here before invoking the app.
// Request headers are never trusted for identity.
const currentUser = new AsyncLocalStorage<AuthUser>();

export function runWithUser<T>(user: AuthUser, run: () => T): T {
  return currentUser.run(user, run);
}

export function getCurrentUser(): AuthUser | null {
  return currentUser.getStore() ?? null;
}
