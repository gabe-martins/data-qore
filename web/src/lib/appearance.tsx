import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
export type Theme = 'light' | 'dark' | 'system';
export type SidebarState = 'expanded' | 'collapsed';
const THEME = 'dataqore.ui.theme', SIDEBAR = 'dataqore.ui.sidebar';
function read<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key); return values.includes(value as T) ? value as T : fallback; } catch { return fallback; }
}
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Keep working in memory. */ } }
const Appearance = createContext<{
  theme: Theme; resolvedTheme: 'light' | 'dark'; setTheme: (theme: Theme) => void;
  sidebar: SidebarState; setSidebar: (state: SidebarState) => void;
} | null>(null);
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(() => read<Theme>(THEME, ['light', 'dark', 'system'], 'system'));
  const [sidebar, updateSidebar] = useState<SidebarState>(() => read<SidebarState>(SIDEBAR, ['expanded', 'collapsed'], 'expanded'));
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change); change();
    const storage = (event: StorageEvent) => {
      if (event.key === THEME || event.key === null) updateTheme(read<Theme>(THEME, ['light', 'dark', 'system'], 'system'));
      if (event.key === SIDEBAR || event.key === null) updateSidebar(read<SidebarState>(SIDEBAR, ['expanded', 'collapsed'], 'expanded'));
    };
    window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', change); window.removeEventListener('storage', storage); };
  }, []);
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);
  const setTheme = useCallback((value: Theme) => { updateTheme(value); save(THEME, value); }, []);
  const setSidebar = useCallback((value: SidebarState) => { updateSidebar(value); save(SIDEBAR, value); }, []);
  return <Appearance.Provider value={{ theme, resolvedTheme, setTheme, sidebar, setSidebar }}>{children}</Appearance.Provider>;
}
export function useAppearance() {
  const value = useContext(Appearance);
  if (!value) throw new Error('AppearanceProvider is required');
  return value;
}
export function BrandLogo({ className, width = 138 }: { className?: string; width?: number }) {
  const { resolvedTheme } = useAppearance();
  return <img className={className} src={`/branding/dataqore-logo${resolvedTheme === 'dark' ? '-inverse' : ''}.svg`} alt="DataQore" width={width} height={Math.round(width * 132 / 606.8)} />;
}
