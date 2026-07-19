import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  getI18nSnapshot,
  initI18n,
  setLanguage,
  subscribeI18n,
  translate,
  type I18nSnapshot,
} from "./registry";

interface I18nContextValue extends I18nSnapshot {
  setLanguage: (locale: string) => Promise<void>;
  t: (key: string, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // useSyncExternalStore re-pulls the snapshot on subscribe, so registrations
  // that land between render and effect are not missed. getI18nSnapshot is
  // referentially stable between mutations, which the API requires.
  const snapshot = useSyncExternalStore(subscribeI18n, getI18nSnapshot, getI18nSnapshot);

  useEffect(() => {
    initI18n().catch(console.warn);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    ...snapshot,
    setLanguage,
    t: translate,
  }), [snapshot]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}
