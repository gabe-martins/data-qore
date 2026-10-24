import { NavLink, Link } from "react-router-dom";
import { ArrowLeft, ShieldCheck, UserRound, Target, X } from "lucide-react";
import { useAccess } from "../lib/access";

export function SettingsSidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate: () => void }) {
  const user = useAccess();
  const administration = [
    { to: "users", label: "Users", permission: "access.manage" },
    { to: "groups", label: "Groups", permission: "access.manage" },
    { to: "audit", label: "Security audit", permission: "audit.read" },
  ].filter(item => !user?.must_change_password && user?.permissions.includes(item.permission));
  return <>
    <div className="settings-sidebar-heading"><h2>Settings</h2>
      {mobile && <button type="button" className="icon-button" aria-label="Close navigation" onClick={onNavigate}><X size={21} /></button>}
    </div>
    <nav aria-label="Settings navigation">
      {administration.length > 0 && <section aria-label="Administration">
        <h3 className="settings-nav-category"><ShieldCheck size={17} aria-hidden="true" />Administration</h3>
        {administration.map(item => <NavLink key={item.to} to={`/settings/${item.to}`} className="settings-nav-link" onClick={onNavigate}>{item.label}</NavLink>)}
      </section>}
      {!user?.must_change_password && user?.permissions.includes("dashboard.read") && <section aria-label="Quality">
        <h3 className="settings-nav-category"><Target size={17} aria-hidden="true" />Quality</h3>
        <NavLink to="/settings/quality" className="settings-nav-link" onClick={onNavigate}>Quality target</NavLink>
      </section>}
      <section aria-label="Personal">
        <h3 className="settings-nav-category"><UserRound size={17} aria-hidden="true" />Personal</h3>
        <NavLink to="/settings/profile" className="settings-nav-link" onClick={onNavigate}>Profile</NavLink>
        <NavLink to="/settings/appearance" className="settings-nav-link" onClick={onNavigate}>Appearance</NavLink>
      </section>
    </nav>
    {!user?.must_change_password && <Link to="/" className="settings-back" onClick={onNavigate}><ArrowLeft size={17} aria-hidden="true" />Back to application</Link>}
  </>;
}
