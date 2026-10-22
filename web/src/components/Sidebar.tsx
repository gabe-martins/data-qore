import { NavLink } from 'react-router-dom';
import { Database, GitCompareArrows, LayoutDashboard, Library, History, LogOut, CalendarClock, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAppearance } from '../lib/appearance';
import { ThemeControl } from './ThemeControl';
import { NavigationTip } from './NavigationTip';
const links = [
  ['/', 'Overview', LayoutDashboard], ['/connections', 'Connections', Database], ['/catalog', 'Catalog', Library],
  ['/comparisons', 'Comparisons', GitCompareArrows], ['/schedules', 'Schedules', CalendarClock], ['/runs', 'Runs', History],
] as const;
export function SidebarContent({ mobile = false, onNavigate, onSignOut }: { mobile?: boolean; onNavigate: () => void; onSignOut: () => void }) {
  const { sidebar, setSidebar } = useAppearance();
  const compact = !mobile && sidebar === 'collapsed';
  const label = compact ? 'Expand sidebar' : 'Collapse sidebar';
  return <>
    <div className="sidebar-heading">
      {mobile ? <button type="button" className="sidebar-toggle" aria-label="Close navigation" onClick={onNavigate}><X size={21} /></button> :
        <NavigationTip enabled={compact} label={label}><button type="button" className="sidebar-toggle" aria-label={label} aria-expanded={!compact} aria-controls="desktop-navigation" onClick={() => setSidebar(compact ? 'expanded' : 'collapsed')}>
          {compact ? <PanelLeftOpen size={21} /> : <PanelLeftClose size={21} />}
        </button></NavigationTip>}
    </div>
    <nav id={mobile ? 'mobile-navigation-links' : 'desktop-navigation'} aria-label="Main navigation">{links.map(([to, name, Icon]) =>
      <NavigationTip key={to} label={name} enabled={compact}><NavLink end={to === '/'} to={to} aria-label={name} onClick={onNavigate} className={({ isActive }) => 'nav-item ' + (isActive ? 'active' : '')}>
        <Icon size={23} aria-hidden="true" /><span className="sidebar-label">{name}</span>
      </NavLink></NavigationTip>
    )}</nav>
    <div className="sidebar-footer">
      <ThemeControl compact={compact} />
      <NavigationTip enabled={compact} label="Sign out"><button type="button" className="nav-item logout" aria-label="Sign out" onClick={onSignOut}>
        <LogOut size={22} aria-hidden="true" /><span className="sidebar-label">Sign out</span>
      </button></NavigationTip>
    </div>
  </>;
}
