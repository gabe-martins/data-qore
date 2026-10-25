import { useLanguage } from "../i18n/LanguageProvider";
import { Card, PageTitle } from "../components/common";
export function Language() {
  const { locale, setLocale, t: tr } = useLanguage();
  return <>
    <PageTitle title={tr("Language")} subtitle={tr("Choose the language used on this browser.")} />
    <Card title={tr("Language")}>
      <fieldset className="language-choices"><legend className="sr-only">{tr("Language")}</legend>
        <label className="check-label"><input type="radio" name="language" value="en-US" checked={locale === "en-US"} onChange={() => setLocale("en-US")} /><span lang="en-US">English</span></label>
        <label className="check-label"><input type="radio" name="language" value="pt-BR" checked={locale === "pt-BR"} onChange={() => setLocale("pt-BR")} /><span lang="pt-BR">Português (Brasil)</span></label>
      </fieldset>
      <p className="muted" role="status">{tr("Your choice is saved automatically on this browser and shared between its tabs.")}</p>
    </Card>
  </>;
}
