import { useLanguage } from "../i18n/LanguageProvider";
import { useAccess } from "../lib/access";
import { NavLink } from 'react-router-dom';
import { Database, GitCompareArrows, LayoutDashboard, Library, History, CalendarClock, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAppearance } from '../lib/appearance';
import { NavigationTip } from './NavigationTip';
const links = [
  ['/', 'Overview', LayoutDashboard], ['/connections', 'Connections', Database], ['/catalog', 'Catalog', Library],
  ['/comparisons', 'Comparisons', GitCompareArrows], ['/schedules', 'Schedules', CalendarClock], ['/runs', 'Runs', History],
] as const;
export function SidebarContent({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate: () => void }) {
  const { t: tr } = useLanguage();
  const user = useAccess();
  const permissions: Record<string, string> = { "/": "dashboard.read", "/connections": "connections.read", "/catalog": "datasets.read", "/comparisons": "comparisons.read", "/schedules": "schedules.read", "/runs": "results.read" };
  const visibleLinks = links.filter(([to]) => !user?.must_change_password && user?.permissions.includes(permissions[to]));
  const { sidebar, setSidebar } = useAppearance();
  const compact = !mobile && sidebar === 'collapsed';
  const label = compact ? 'Expand sidebar' : 'Collapse sidebar';
  return <>
    <div className="sidebar-heading">
      {mobile ? <button type="button" className="sidebar-toggle" aria-label={tr("Close navigation")} onClick={onNavigate}><X size={21} /></button> :
        <NavigationTip enabled={compact} label={tr(label)}><button type="button" className="sidebar-toggle" aria-label={tr(label)} aria-expanded={!compact} aria-controls="desktop-navigation" onClick={() => setSidebar(compact ? 'expanded' : 'collapsed')}>
          {compact ? <PanelLeftOpen size={21} /> : <PanelLeftClose size={21} />}
        </button></NavigationTip>}
    </div>
    <nav id={mobile ? 'mobile-navigation-links' : 'desktop-navigation'} aria-label={tr("Main navigation")}>{visibleLinks.map(([to, name, Icon]) =>
      <NavigationTip key={to} label={tr(name)} enabled={compact}><NavLink end={to === '/'} to={to} aria-label={tr(name)} onClick={onNavigate} className={({ isActive }) => 'nav-item ' + (isActive ? 'active' : '')}>
        <Icon size={23} aria-hidden="true" /><span className="sidebar-label">{tr(name)}</span>
      </NavLink></NavigationTip>
    )}</nav>
  </>;
}
