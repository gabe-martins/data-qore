import { lazy, Suspense, useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Menu, UserRound } from "lucide-react";
import * as NavigationDialog from "@radix-ui/react-dialog";
import { SidebarContent } from "./components/Sidebar";
import { ThemeControl } from "./components/ThemeControl";
import { useAppearance, BrandLogo } from "./lib/appearance";
import {
  login,
  logout,
  refresh,
  onSessionExpired,
  post,
  type User,
} from "./api";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  PageTitle,
} from "./components/common";
const Overview = lazy(() =>
  import("./pages/Overview").then((m) => ({ default: m.Overview })),
);
const Connections = lazy(() =>
  import("./pages/Connections").then((m) => ({ default: m.Connections })),
);
const Schedules = lazy(() => import("./pages/Schedules").then(m => ({ default: m.Schedules })));
const Catalog = lazy(() =>
  import("./pages/Catalog").then((m) => ({ default: m.Catalog })),
);
const DatasetDetail = lazy(() =>
  import("./pages/Catalog").then((m) => ({ default: m.DatasetDetail })),
);
const Comparisons = lazy(() =>
  import("./pages/Comparisons").then((m) => ({ default: m.Comparisons })),
);
const ComparisonDetail = lazy(() =>
  import("./pages/Comparisons").then((m) => ({ default: m.ComparisonDetail })),
);
const Wizard = lazy(() =>
  import("./pages/Comparisons").then((m) => ({ default: m.Wizard })),
);
const Runs = lazy(() =>
  import("./pages/Runs").then((m) => ({ default: m.Runs })),
);
const RunResult = lazy(() =>
  import("./pages/Runs").then((m) => ({ default: m.RunResult })),
);
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState(false);
  const { sidebar } = useAppearance();
  useEffect(() => {
    const desktop = matchMedia('(min-width: 851px)');
    const changed = () => { if (desktop.matches) setMenu(false); };
    desktop.addEventListener('change', changed);
    return () => desktop.removeEventListener('change', changed);
  }, []);
  const cache = useQueryClient();
  const navigate = useNavigate();
  function expire() {
    setUser(null);
    cache.clear();
  }
  useEffect(() => {
    let active = true;
    onSessionExpired(() => {
      if (active) expire();
    });
    refresh().then((u) => {
      if (active) {
        setUser(u);
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  if (!ready) return <Loading />;
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          cache.clear();
          setUser(u);
          navigate("/");
        }}
      />
    );
  async function signOut() { setMenu(false); await logout(); expire(); }
  return (
    <NavigationDialog.Root open={menu} onOpenChange={setMenu}>
    <div className="app-shell" data-sidebar={sidebar}>
      <aside className="sidebar sidebar-desktop" data-compact={sidebar === 'collapsed'} aria-label="Desktop sidebar">
        <SidebarContent onNavigate={() => {}} onSignOut={() => { void signOut(); }} />
      </aside>
      <NavigationDialog.Portal>
        <NavigationDialog.Overlay className="navigation-overlay" />
        <NavigationDialog.Content className="sidebar navigation-drawer" id="mobile-navigation" onCloseAutoFocus={event => {
          if (matchMedia('(min-width: 851px)').matches) {
            event.preventDefault(); document.querySelector<HTMLButtonElement>('.sidebar-desktop .sidebar-toggle')?.focus();
          }
        }}>
          <NavigationDialog.Title className="sr-only">Main navigation</NavigationDialog.Title>
          <NavigationDialog.Description className="sr-only">Choose a page, appearance or sign out.</NavigationDialog.Description>
          <SidebarContent mobile onNavigate={() => setMenu(false)} onSignOut={() => { void signOut(); }} />
        </NavigationDialog.Content>
      </NavigationDialog.Portal>
      <div className="app-main">
        <header className="topbar">
          <NavigationDialog.Trigger asChild>
            <button type="button" className="icon-button mobile-menu" aria-label="Toggle navigation" aria-controls="mobile-navigation"><Menu /></button>
          </NavigationDialog.Trigger>
          <div className="product-title">
            <div className="brand-mark">
              <img src="/branding/dataqore-symbol.svg" alt="" width="40" height="40" />
            </div>
            <strong>
              ADQ <span>— Advanced Data Quality</span>
            </strong>
          </div>
          <NavLink to="/account" className="profile-link">
            <UserRound size={21} />
            <span>{user.display_name}</span>
          </NavLink>
          <BrandLogo className="wordmark" />
        </header>
        <main className="page">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/datasets/:id" element={<DatasetDetail />} />
              <Route path="/comparisons" element={<Comparisons />} />
              <Route path="/schedules" element={<Schedules />} />
              <Route path="/comparisons/new" element={<Wizard />} />
              <Route path="/comparisons/:id/edit" element={<Wizard />} />
              <Route path="/comparisons/:id" element={<ComparisonDetail />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunResult />} />
              <Route
                path="/runs/:id/differences"
                element={<RunResult differences />}
              />
              <Route
                path="/account"
                element={<Account user={user} onChanged={expire} />}
              />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </Suspense>
        </main>
        <footer className="app-footer">
          DataQore · ADQ · Sample-based evidence, with context and coverage.
        </footer>
      </div>
    </div>
    </NavigationDialog.Root>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="login-screen">
      <section className="login-brand">
        <div className="login-logo">
          <img src="/branding/dataqore-logo.svg" alt="DataQore" width="276" height="60" />
        </div>
        <p className="eyebrow">DATAQORE / ADQ</p>
        <h1>Trust your data.</h1>
        <p>
          Understand quality. Compare with evidence.
          <br />
          Make every result count.
        </p>
        <div className="login-lines" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>
      <section className="login-panel">
        <div className="login-theme"><ThemeControl login /></div>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            try {
              onLogin(
                await login(String(f.get("email")), String(f.get("password"))),
              );
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <BrandLogo className="login-mobile-logo" width={230} />
          <p className="eyebrow">ADVANCED DATA QUALITY</p>
          <h1>Welcome back</h1>
          <p className="muted">Sign in to your local DataQore account.</p>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <ErrorBox error={error} />
          <Button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
          <p className="muted small">
            First time here? Create your administrator using the local setup
            command.
          </p>
        </form>
      </section>
    </div>
  );
}
function Account({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageTitle
        title="Account"
        subtitle="Manage your local administrator credentials."
      />
      <div className="two-columns">
        <Card title="Profile">
          <dl>
            <dt>Name</dt>
            <dd>{user.display_name}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>Administrator</dd>
          </dl>
        </Card>
        <Card
          title="Change password"
          subtitle="Changing your password signs out all sessions."
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (f.get("new_password") !== f.get("confirm")) {
                setError(Error("Passwords do not match."));
                return;
              }
              setBusy(true);
              setError(null);
              try {
                await post("/auth/change-password", {
                  current_password: f.get("current_password"),
                  new_password: f.get("new_password"),
                });
                onChanged();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Current password
              <input
                name="current_password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              New password
              <input
                name="new_password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label>
              Confirm new password
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <ErrorBox error={error} />
            <Button disabled={busy}>Change password</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
