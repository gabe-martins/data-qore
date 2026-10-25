import { useLanguage } from "../i18n/LanguageProvider";
import { Card, PageTitle } from "../components/common";
import { ThemeChoices } from "../components/ThemeControl";

export function Appearance() {
  const { t: tr } = useLanguage();
  return <>
    <PageTitle title={tr("Appearance")} subtitle={tr("Choose how DataQore looks on this browser.")} />
    <Card title={tr("Theme")}><p className="muted">{tr("System follows your device. Your choice is saved automatically on this browser.")}</p>
      <div className="settings-theme-choices"><ThemeChoices /></div>
    </Card>
  </>;
}
