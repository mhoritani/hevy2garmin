import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";

export const PROFILE_COOKIE = "h2g_profile";
export const DEFAULT_PROFILE_ID = "default";
const context = new AsyncLocalStorage<string>();

/** Scheduled work carries its profile independently of browser cookies. */
export function withProfile<T>(id: string, run: () => T): T {
  return context.run(id, run);
}

export async function activeProfileId(): Promise<string> {
  const selected = context.getStore();
  if (selected) return selected;
  try {
    return (await cookies()).get(PROFILE_COOKIE)?.value ?? DEFAULT_PROFILE_ID;
  } catch (error) {
    // Preserve single-account use outside Next requests; rendering errors still reach Next.
    if (error instanceof Error && /outside a request scope/.test(error.message)) return DEFAULT_PROFILE_ID;
    throw error;
  }
}
