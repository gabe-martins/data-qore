import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, LogOut, Monitor, Settings, UserRound } from "lucide-react";
import type { User } from "../api";
import { ThemeChoices } from "./ThemeControl";

export function UserMenu({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const settingsLink = useRef<HTMLAnchorElement>(null);
  const themeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const previousView = useRef(false);
  useLayoutEffect(() => {
    if (open && previousView.current !== showTheme) {
      (showTheme ? backButton : themeButton).current?.focus();
    }
    previousView.current = open && showTheme;
  }, [open, showTheme]);
  return <Dialog.Root modal={false} open={open} onOpenChange={value => { setOpen(value); if (!value) setShowTheme(false); }}>
    <Dialog.Trigger asChild>
      <button type="button" className="profile-link" aria-label="User menu" title="User menu">
        <UserRound size={21} aria-hidden="true" />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content className="user-menu" aria-describedby={undefined} onOpenAutoFocus={event => {
        event.preventDefault(); settingsLink.current?.focus();
      }} onEscapeKeyDown={event => {
        if (showTheme) { event.preventDefault(); setShowTheme(false); }
      }}>
        <Dialog.Title className="sr-only">User menu</Dialog.Title>
        {showTheme ? <>
          <button ref={backButton} type="button" className="user-menu-action user-menu-back" onClick={() => setShowTheme(false)}><ChevronLeft size={18} aria-hidden="true" />Back</button>
          <ThemeChoices compact />
        </> : <>
        <div className="user-menu-identity"><strong>{user.display_name}</strong><span className="muted">{user.email}</span></div>
        <nav aria-label="User actions">
          <Dialog.Close asChild><Link ref={settingsLink} to="/settings" className="user-menu-action"><Settings size={18} aria-hidden="true" />Settings</Link></Dialog.Close>
          <button ref={themeButton} type="button" className="user-menu-action" onClick={() => setShowTheme(true)}><Monitor size={18} aria-hidden="true" />Theme<ChevronRight size={17} className="theme-menu-chevron" aria-hidden="true" /></button>
          <button type="button" className="user-menu-action user-menu-signout" onClick={() => { setOpen(false); void onSignOut(); }}><LogOut size={18} aria-hidden="true" />Sign out</button>
        </nav>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
