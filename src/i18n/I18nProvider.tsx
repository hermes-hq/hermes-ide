import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
  const [snapshot, setSnapshot] = useState<I18nSnapshot>(() => getI18nSnapshot());

  useEffect(() => {
    const unsubscribe = subscribeI18n(() => setSnapshot(getI18nSnapshot()));
    initI18n().catch(console.warn);
    return unsubscribe;
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
