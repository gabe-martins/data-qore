import { Card, PageTitle } from "../components/common";
import { ThemeChoices } from "../components/ThemeControl";

export function Appearance() {
  return <>
    <PageTitle title="Appearance" subtitle="Choose how DataQore looks on this browser." />
    <Card title="Theme"><p className="muted">System follows your device. Your choice is saved automatically on this browser.</p>
      <div className="settings-theme-choices"><ThemeChoices /></div>
    </Card>
  </>;
}
