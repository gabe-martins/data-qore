import * as Dialog from '@radix-ui/react-dialog';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import { useAppearance, type Theme } from '../lib/appearance';
import { NavigationTip } from './NavigationTip';
const choices = [{ value: 'light', label: 'Light', Icon: Sun }, { value: 'dark', label: 'Dark', Icon: Moon }, { value: 'system', label: 'System', Icon: Monitor }] as const;
export function ThemeControl({ compact = false, login = false }: { compact?: boolean; login?: boolean }) {
  const { theme, setTheme } = useAppearance();
  const Icon = choices.find(c => c.value === theme)!.Icon;
  return <Dialog.Root>
    <NavigationTip enabled={compact} label={`Theme: ${theme}`}>
      <Dialog.Trigger asChild><button type="button" className={login ? 'theme-trigger' : 'nav-item'} aria-label="Theme">
        <Icon size={22} aria-hidden="true" /><span className="sidebar-label">Theme</span>
      </button></Dialog.Trigger>
    </NavigationTip>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay theme-overlay" />
      <Dialog.Content className="dialog-content theme-dialog">
        <Dialog.Title className="dialog-title">Theme</Dialog.Title>
        <Dialog.Description className="muted">Choose your appearance for this browser. System follows your device.</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" aria-label="Close theme settings"><X size={22} /></Dialog.Close>
        <fieldset className="theme-choices"><legend className="sr-only">Appearance</legend>{choices.map(({ value, label, Icon: OptionIcon }) => <label key={value}>
          <input type="radio" name="appearance" value={value} checked={theme === value} onChange={() => setTheme(value as Theme)} />
          <OptionIcon size={20} aria-hidden="true" /><span>{label}</span>
        </label>)}</fieldset>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
