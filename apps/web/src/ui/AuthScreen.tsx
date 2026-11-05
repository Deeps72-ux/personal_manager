import { useState, type FormEvent } from "react";
import { useServices } from "./services.tsx";

export function AuthScreen({ expired, onDone }: { expired: boolean; onDone: () => void }) {
  const { auth } = useServices();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (mode === "signin" ? auth.signIn(username, password) : auth.signUp(username, password));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>Personal Manager</h1>
        <p className="muted">Prioritise. Log your day. On every device.</p>

        {expired && (
          <p className="notice" role="status">
            Your session ended. Sign in again; changes made on this device are kept and will sync.
          </p>
        )}

        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={3}
            maxLength={32}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={8}
          />
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
