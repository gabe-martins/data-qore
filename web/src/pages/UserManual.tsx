import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import { Button } from "../components/common";
import { useLanguage } from "../i18n/LanguageProvider";
import type { Locale } from "../i18n/core";
import portuguese from "../content/user-manual.html?raw";
import english from "../content/user-manual.en-US.html?raw";
import "./UserManual.css";
// Only these bundled, locally authored documents are accepted. Never render API/user HTML.
const documents = Object.fromEntries(Object.entries({ "en-US": english, "pt-BR": portuguese }).map(([locale, html]) => {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return [locale, { html, content: parsed.querySelector("main")!.innerHTML, styles: parsed.getElementById("manual-styles")!.textContent! }];
})) as Record<Locale, { html: string; content: string; styles: string }>;
export function UserManual() {
  const { locale, t } = useLanguage();
  const { hash } = useLocation();
  const manual = documents[locale];
  useEffect(() => {
    const previous = document.title;
    document.title = t("User manual · DataQore");
    return () => { document.title = previous; };
  }, [locale, t]);
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, locale]);
  function download() {
    const url = URL.createObjectURL(new Blob([manual.html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = locale === "pt-BR" ? "dataqore-manual-de-uso.html" : "dataqore-user-manual.html";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <div className="manual-tools" lang={locale} role="group" aria-label={t("Manual options")}>
      <Button variant="outline" onClick={download}><Download size={16} aria-hidden="true" />{t("Download HTML")}</Button>
      <Button variant="outline" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />{t("Print / save PDF")}</Button>
    </div>
    <style>{manual.styles}</style>
    <article className="user-manual" lang={locale} aria-label={t("DataQore user manual")} dangerouslySetInnerHTML={{ __html: manual.content }} />
  </>;
}
