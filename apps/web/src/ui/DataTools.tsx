import { useState } from "react";
import { todayLocal } from "@pm/shared";
import { useLive, useServices } from "./services.tsx";

/** Export logs to Excel (date range) and delete old logs (with a guard). */
export function DataTools() {
  const { exporter, logs } = useServices();
  const today = todayLocal();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [before, setBefore] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const purgedBefore = useLive((s) => s.store.purgedBefore(), []);

  const doExport = async () => {
    try {
      const r = await exporter.execute(from, to);
      setExportMsg({ ok: true, text: `Saved ${r.fileName} (${r.rows} entr${r.rows === 1 ? "y" : "ies"})` });
    } catch (err) {
      setExportMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const doPurge = async () => {
    try {
      await logs.purgeBefore(before);
      setPurgeMsg(`Deleted all logs before ${before} on every device.`);
      setConfirm(false);
      setBefore("");
    } catch (err) {
      setPurgeMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="panel datatools">
      <div className="tool">
        <h3>Export to Excel</h3>
        <div className="row wrap">
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="primary" onClick={() => void doExport()}>
            Download .xlsx
          </button>
        </div>
        {exportMsg && <p className={exportMsg.ok ? "success" : "error"}>{exportMsg.text}</p>}
      </div>

      <div className="tool">
        <h3>Delete old logs</h3>
        <p className="muted">
          Permanently removes log entries dated before the chosen day, on all devices. Tasks are not affected.
          {purgedBefore && <> Currently cleared up to {purgedBefore}.</>}
        </p>
        <div className="row wrap">
          <label>
            Delete logs before
            <input
              type="date"
              value={before}
              max={today}
              onChange={(e) => {
                setBefore(e.target.value);
                setConfirm(false);
                setPurgeMsg(null);
              }}
            />
          </label>
          {!confirm ? (
            <button className="danger-outline" disabled={!before} onClick={() => setConfirm(true)}>
              Delete…
            </button>
          ) : (
            <span className="inline-confirm">
              <button className="danger" onClick={() => void doPurge()}>
                Yes, delete permanently
              </button>
              <button className="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>
        {purgeMsg && <p className="success">{purgeMsg}</p>}
      </div>
    </div>
  );
}
