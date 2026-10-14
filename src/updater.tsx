import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { api, errorText } from "./api";
import { useApp } from "./context";
import { Modal } from "./components/Modal";
import { useAppVersion } from "./version";

type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; done: number; total: number | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

/**
 * Automatic updates from the GitHub releases.
 *
 * Shortly after login the app asks GitHub whether a newer signed version exists. If so, a window shows
 * what is new; "Installer" makes a safety copy of the database, downloads the installer (with progress),
 * installs it and restarts. The data lives outside the program folder, so it is kept as is.
 */
export function useUpdater(): {
  available: string | null;
  check: (manual: boolean) => Promise<void>;
  open: () => void;
  dialog: ReactNode;
} {
  const { t, toast } = useApp();
  const current = useAppVersion();
  const [update, setUpdate] = useState<Update | null>(null);
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const checked = useRef(false);

  const check = useCallback(
    async (manual: boolean) => {
      try {
        const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
        const u = await checkUpdate();
        if (u) {
          setUpdate(u);
          setShow(true);
        } else if (manual) {
          toast(t("upd.upToDate"));
        }
      } catch (e) {
        // Offline or no published update yet: only report it when the user asked.
        if (manual) toast(t("upd.checkFailed", { e: errorText(e) }), "error");
      }
    },
    [t, toast],
  );

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const h = setTimeout(() => void check(false), 4000);
    return () => clearTimeout(h);
  }, [check]);

  async function install() {
    if (!update) return;
    try {
      setPhase({ kind: "downloading", done: 0, total: null });
      await api.backupBeforeUpdate();
      let done = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") setPhase({ kind: "downloading", done: 0, total: ev.data.contentLength ?? null });
        else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setPhase((p) => (p.kind === "downloading" ? { ...p, done } : p));
        } else if (ev.event === "Finished") setPhase({ kind: "installing" });
      });
      setPhase({ kind: "installing" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", message: errorText(e) });
    }
  }

  const busy = phase.kind === "downloading" || phase.kind === "installing";
  const pct = phase.kind === "downloading" && phase.total ? Math.min(100, Math.round((phase.done / phase.total) * 100)) : null;
  const mb = (n: number) => (n / 1_048_576).toFixed(1);

  const dialog =
    show && update ? (
      <Modal title={t("upd.title")} onClose={() => !busy && setShow(false)}>
        <div className="update-dialog">
          <div className="update-hero">
            <div className="logo big-logo">AB</div>
            <div>
              <div className="update-versions">
                <span className="muted">{current ?? update.currentVersion}</span>
                <span className="arrow">→</span>
                <strong>{update.version}</strong>
              </div>
              {update.date && <div className="muted small">{new Date(update.date).toLocaleDateString()}</div>}
            </div>
          </div>
          {update.body && (
            <div className="update-notes">
              <div className="field-label">{t("upd.whatsNew")}</div>
              <div className="update-body">{update.body}</div>
            </div>
          )}
          <p className="update-safe">🛡 {t("upd.safe")}</p>

          {phase.kind === "downloading" && (
            <div className="update-progress">
              <div className="bar">
                <div style={{ width: pct != null ? `${pct}%` : "35%" }} className={pct == null ? "indeterminate" : ""} />
              </div>
              <span className="muted small">
                {t("upd.downloading")}{" "}
                {pct != null ? `${pct}% · ${mb(phase.done)} / ${mb(phase.total!)} Mo` : `${mb(phase.done)} Mo`}
              </span>
            </div>
          )}
          {phase.kind === "installing" && <p className="muted">{t("upd.installing")}</p>}
          {phase.kind === "error" && <div className="auth-error">{t("upd.failed", { e: phase.message })}</div>}

          <footer className="form-actions end">
            <button className="btn ghost" disabled={busy} onClick={() => setShow(false)}>
              {t("upd.later")}
            </button>
            <button className="btn primary" disabled={busy} onClick={install}>
              ⬇ {t("upd.install")}
            </button>
          </footer>
        </div>
      </Modal>
    ) : null;

  return { available: update?.version ?? null, check, open: () => setShow(true), dialog };
}
