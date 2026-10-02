import { createContext, useContext } from "react";
import type { SessionData } from "../types/session";

/**
 * The React context SessionProvider fills (see SessionContext.tsx). Kept in
 * a module of its own so a component that is also rendered outside the
 * provider (in a panel's own tests) can read it optionally, without the
 * provider's whole module.
 */
export const SessionContextObject = createContext<unknown>(null);

/** The sessions SessionProvider holds, or null outside one. */
export function useOptionalSessions(): Readonly<Record<string, SessionData>> | null {
  const ctx = useContext(SessionContextObject) as { state?: { sessions?: Record<string, SessionData> } } | null;
  return ctx?.state?.sessions ?? null;
}
