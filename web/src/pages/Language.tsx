import { useId } from "react";
import { Check } from "lucide-react";
import { useLanguage } from "../i18n/LanguageProvider";
import { Card, PageTitle } from "../components/common";
export function Language() {
  const { locale, setLocale, t: tr } = useLanguage();
  const countryId = useId();
  return <>
    <PageTitle title={tr("Language")} subtitle={tr("Choose the language used on this browser.")} />
    <Card className="language-card">
      <fieldset className="language-choices"><legend className="sr-only">{tr("Language")}</legend>
        <label className="language-option">
          <input type="radio" name="language" value="en-US" aria-label="English" aria-describedby={`${countryId}-us`} checked={locale === "en-US"} onChange={() => setLocale("en-US")} />
          <img className="language-flag" src="/flags/us.svg" alt="" aria-hidden="true" width="36" height="24" />
          <span className="language-option-text"><strong lang="en-US">English</strong><span id={`${countryId}-us`}>{tr("United States")}</span></span>
          <span className="language-option-indicator" aria-hidden="true">{locale === "en-US" && <Check size={16} strokeWidth={2.5} />}</span>
        </label>
        <label className="language-option">
          <input type="radio" name="language" value="pt-BR" aria-label="Português (Brasil)" aria-describedby={`${countryId}-br`} checked={locale === "pt-BR"} onChange={() => setLocale("pt-BR")} />
          <img className="language-flag" src="/flags/br.svg" alt="" aria-hidden="true" width="36" height="24" />
          <span className="language-option-text"><strong lang="pt-BR">Português (Brasil)</strong><span id={`${countryId}-br`}>{tr("Brazil")}</span></span>
          <span className="language-option-indicator" aria-hidden="true">{locale === "pt-BR" && <Check size={16} strokeWidth={2.5} />}</span>
        </label>
      </fieldset>
      <p className="muted" role="status">{tr("Your choice is saved automatically on this browser and shared between its tabs.")}</p>
    </Card>
  </>;
}
