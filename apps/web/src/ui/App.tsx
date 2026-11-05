import { useEffect, useState } from "react";
import type { User } from "@pm/shared";
import { AuthScreen } from "./AuthScreen.tsx";
import { CalendarIcon, ListIcon, StackIcon } from "./icons.tsx";
import { LogView } from "./LogView.tsx";
import { PriorityView } from "./PriorityView.tsx";
import { useLive, useServices } from "./services.tsx";
import { SyncBadge } from "./SyncBadge.tsx";
import { TasksView } from "./TasksView.tsx";

type Tab = "tasks" | "priority" | "log";
const TABS: { id: Tab; label: string; Icon: () => React.JSX.Element }[] = [
  { id: "tasks", label: "Tasks", Icon: ListIcon },
  { id: "priority", label: "Priority", Icon: StackIcon },
  { id: "log", label: "Log", Icon: CalendarIcon },
];

const TAB_KEY = "pm.tab";
const readTab = (): Tab => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return t === "tasks" || t === "priority" || t === "log" ? t : "priority";
  } catch {
    return "priority";
  }
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
  const [tab, setTab] = useState<Tab>(readTab);
  const choose = (t: Tab) => {
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
          {TABS.map(({ id, label }) => (
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
        {tab === "tasks" && <TasksView />}
        {tab === "priority" && <PriorityView onGoToTasks={() => choose("tasks")} />}
        {tab === "log" && <LogView />}
      </main>

      <nav className="tabs tabs-bottom" aria-label="Sections">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id} onClick={() => choose(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
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
