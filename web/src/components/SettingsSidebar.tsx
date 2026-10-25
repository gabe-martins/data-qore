import { useLanguage } from "../i18n/LanguageProvider";
import { NavLink, Link } from "react-router-dom";
import { ArrowLeft, BookOpen, ShieldCheck, UserRound, Target, X } from "lucide-react";
import { useAccess } from "../lib/access";

export function SettingsSidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate: () => void }) {
  const { t: tr } = useLanguage();
  const user = useAccess();
  const administration = [
    { to: "users", label: "Users", permission: "access.manage" },
    { to: "groups", label: "Groups", permission: "access.manage" },
    { to: "audit", label: "Security audit", permission: "audit.read" },
  ].filter(item => !user?.must_change_password && user?.permissions.includes(item.permission));
  return <>
    <div className="settings-sidebar-heading"><h2>{tr("Settings")}</h2>
      {mobile && <button type="button" className="icon-button" aria-label={tr("Close navigation")} onClick={onNavigate}><X size={21} /></button>}
    </div>
    <nav aria-label={tr("Settings navigation")}>
      {administration.length > 0 && <section aria-label={tr("Administration")}>
        <h3 className="settings-nav-category"><ShieldCheck size={17} aria-hidden="true" />{tr("Administration")}</h3>
        {administration.map(item => <NavLink key={item.to} to={`/settings/${item.to}`} className="settings-nav-link" onClick={onNavigate}>{tr(item.label)}</NavLink>)}
      </section>}
      {!user?.must_change_password && user?.permissions.includes("dashboard.read") && <section aria-label={tr("Quality")}>
        <h3 className="settings-nav-category"><Target size={17} aria-hidden="true" />{tr("Quality")}</h3>
        <NavLink to="/settings/quality" className="settings-nav-link" onClick={onNavigate}>{tr("Quality target")}</NavLink>
      </section>}
      <section aria-label={tr("Personal")}>
        <h3 className="settings-nav-category"><UserRound size={17} aria-hidden="true" />{tr("Personal")}</h3>
        <NavLink to="/settings/profile" className="settings-nav-link" onClick={onNavigate}>{tr("Profile")}</NavLink>
        <NavLink to="/settings/language" className="settings-nav-link" onClick={onNavigate}>{tr("Language")}</NavLink>
        <NavLink to="/settings/appearance" className="settings-nav-link" onClick={onNavigate}>{tr("Appearance")}</NavLink>
      </section>
      {!user?.must_change_password && user?.permissions.includes("dashboard.read") && <section aria-label={tr("Help")}>
        <h3 className="settings-nav-category"><BookOpen size={17} aria-hidden="true" />{tr("Help")}</h3>
        <NavLink to="/settings/manual" className="settings-nav-link" onClick={onNavigate}>{tr("User manual")}</NavLink>
      </section>}
    </nav>
    {!user?.must_change_password && <Link to="/" className="settings-back" onClick={onNavigate}><ArrowLeft size={17} aria-hidden="true" />{tr("Back to application")}</Link>}
  </>;
}
