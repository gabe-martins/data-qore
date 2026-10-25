import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { LANGUAGE_KEY, isLocale, translate, numberText, dateTimeText, reasonText, decimalText, type Locale, type Parameters } from "./core";
function readLocale(): Locale {
  try { const value = localStorage.getItem(LANGUAGE_KEY); return isLocale(value) ? value : "en-US"; }
  catch { return "en-US"; }
}
const LanguageContext = createContext<ReturnType<typeof makeLanguage> & { setLocale: (locale: Locale) => void } | null>(null);
function makeLanguage(locale: Locale) {
  return {
    locale,
    t: (message: string, values?: Parameters) => translate(message, locale, values),
    formatNumber: (value: number) => numberText(value, locale),
    formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => dateTimeText(value, locale, options),
    decimal: (value: string | number) => decimalText(value, locale),
    reason: (message: string) => reasonText(message, locale),
  };
}
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState<Locale>(readLocale);
  const language = useMemo(() => ({ ...makeLanguage(locale), setLocale: (next: Locale) => {
    if (!isLocale(next)) return;
    update(next);
    try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Keep the selection in memory. */ }
  } }), [locale]);
  useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === LANGUAGE_KEY || event.key === null) update(readLocale()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  // Translate browser validation messages without changing form constraints or payloads.
  useEffect(() => {
    const clear = (event: Event) => { const field = event.target; if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.setCustomValidity(""); };
    const invalid = (event: Event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
      field.setCustomValidity("");
      const v = field.validity;
      if (v.valid) return;
      const message = v.valueMissing ? "This field is required." : v.typeMismatch && field instanceof HTMLInputElement && field.type === "email" ? "Enter a valid email address." : v.patternMismatch ? "Use the required format for this field." : "Review the value and the limits shown for this field.";
      if (locale === "pt-BR") field.setCustomValidity(translate(message, locale));
    };
    document.querySelectorAll("input,select,textarea").forEach(el => { if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.setCustomValidity(""); });
    document.addEventListener("input", clear, true); document.addEventListener("change", clear, true); document.addEventListener("invalid", invalid, true);
    return () => { document.removeEventListener("input", clear, true); document.removeEventListener("change", clear, true); document.removeEventListener("invalid", invalid, true); };
  }, [locale]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}
export function useLanguage() {
  const language = useContext(LanguageContext);
  if (!language) throw new Error("LanguageProvider is required");
  return language;
}
