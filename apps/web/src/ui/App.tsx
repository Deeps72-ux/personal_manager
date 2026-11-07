import { useEffect, useState } from "react";
import type { User } from "@pm/shared";
import { AuthScreen } from "./AuthScreen.tsx";
import { activeFeatures, resolveFeatureId } from "./features.tsx";
import { useLive, useServices } from "./services.tsx";
import { SyncBadge } from "./SyncBadge.tsx";
import { useTheme, type ThemeChoice } from "./theme.ts";

const FEATURE_LIST = activeFeatures();

const TAB_KEY = "pm.tab";
const readTab = (): string => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    // private mode: fall back to the default
  }
  return resolveFeatureId(saved, FEATURE_LIST);
};

export function App() {
  const { auth, holder, sync } = useServices();
  const [user, setUser] = useState<User | null | "loading">("loading");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    void auth.restore().then((u) => alive && setUser(u));
    const off = holder.subscribe((s) => {
      // Signed out by the server (not by the user): explain it on the login screen.
      if (!s) setExpired(sync.getStatus().state === "unauthorized");
      setUser(s?.user ?? null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [auth, holder, sync]);

  useEffect(() => {
    if (!user || user === "loading") return;
    sync.start();
    return () => sync.stop();
  }, [user, sync]);

  if (user === "loading") return <div className="splash" aria-busy="true" />;
  if (!user) return <AuthScreen expired={expired} onDone={() => setExpired(false)} />;
  return <Shell user={user} />;
}

function Shell({ user }: { user: User }) {
  const [tab, setTab] = useState<string>(readTab);
  const choose = (t: string) => {
    if (!FEATURE_LIST.some((f) => f.id === t)) return;
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // private mode: fine, just not remembered
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Personal Manager</span>
        </div>
        <nav className="tabs tabs-top" aria-label="Sections">
          {FEATURE_LIST.map(({ id, label }) => (
            <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <SyncBadge />
          <UserMenu user={user} />
        </div>
      </header>

      <main className="content">
        {FEATURE_LIST.map(({ id, View }) => id === tab && <View key={id} navigate={choose} />)}
      </main>

      <nav className="tabs tabs-bottom" aria-label="Sections">
        {FEATURE_LIST.map(({ id, label, Icon }) => (
          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id} onClick={() => choose(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Per-device appearance: remembered on this device only, never synced. */
function AppearancePicker() {
  const [theme, setTheme] = useTheme();
  return (
    <div role="group" aria-label="Appearance">
      <div className="menu-label">Appearance (this device)</div>
      <div className="segmented three">
        {THEMES.map((t) => (
          <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMenu({ user }: { user: User }) {
  const { auth } = useServices();
  // Read the outbox directly: the SyncEngine may be stopped (e.g. expired session).
  const pending = useLive(async (s) => (await s.store.listOutbox()).length, []) ?? 0;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="usermenu">
      <button className="ghost avatar" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Account">
        {user.username.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-user">
            Signed in as <strong>{user.username}</strong>
          </div>
          <AppearancePicker />
          {!confirm ? (
            <button className="danger-text" onClick={() => (pending > 0 ? setConfirm(true) : void auth.signOut())}>
              Sign out
            </button>
          ) : (
            <div className="confirm">
              <p>
                {pending} change{pending === 1 ? " is" : "s are"} not synced yet and will be lost on this device.
              </p>
              <button className="danger" onClick={() => void auth.signOut()}>
                Sign out anyway
              </button>
              <button className="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
