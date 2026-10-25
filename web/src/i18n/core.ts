import { ptBR } from "./pt-BR.ts";
export type Locale = "en-US" | "pt-BR";
export type MessageKey = keyof typeof ptBR;
export const enUS = Object.fromEntries(Object.keys(ptBR).map(key => [key, key])) as Record<MessageKey, string>;
export const catalogs: Record<Locale, Readonly<Record<MessageKey, string>>> = { "en-US": enUS, "pt-BR": ptBR };
export const LANGUAGE_KEY = "dataqore.ui.language";
export const isLocale = (value: unknown): value is Locale => value === "en-US" || value === "pt-BR";
export type Parameters = Record<string | number, string | number>;
export function translate(message: string, locale: Locale, values: Parameters = {}): string {
  const key = message.trim() as MessageKey;
  const translated = Object.hasOwn(catalogs[locale], key) ? catalogs[locale][key] : key;
  const result = translated.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
  return (message.match(/^\s*/)?.[0] ?? "") + result + (message.match(/\s*$/)?.[0] ?? "");
}
export function reasonText(value: string, locale: Locale): string {
  const known = value.replaceAll("_", " ");
  const sourceWarning = /^Source ([12]): reads use best effort; separate queries may observe different states\.$/.exec(value);
  if (sourceWarning) return translate("Source {0}: reads use best effort; separate queries may observe different states.", locale, { 0: sourceWarning[1] });
  const compatibility = /^(\d+) unpaired or incompatible column pairs\. This is a technical diagnostic, not a quality score\.$/.exec(value);
  if (compatibility) return translate("{0} unpaired or incompatible column pairs. This is a technical diagnostic, not a quality score.", locale, { 0: compatibility[1] });
  return Object.hasOwn(ptBR, value.trim()) ? translate(value, locale) : translate(known, locale);
}
export function numberText(value: number, locale: Locale): string { return value.toLocaleString(locale); }
export function dateTimeText(value: string | number | Date, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString(locale, options);
}
export function pluralText(count: number, locale: Locale, one: string, other: string): string {
  return translate(new Intl.PluralRules(locale).select(count) === "one" ? one : other, locale);
}

/** Format configuration decimals without a Number conversion or loss of precision. */
export function decimalText(value: string | number, locale: Locale): string {
  return locale === "pt-BR" ? String(value).replace(".", ",") : String(value);
}
