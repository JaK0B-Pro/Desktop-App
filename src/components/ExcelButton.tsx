import { useState } from "react";
import { useApp } from "../context";

/**
 * "📗 Excel" button: builds a formatted .xlsx (saved in Documents/AccountBook/Excel), which then
 * opens in Excel.
 */
export function ExcelButton({ run, small }: { run: () => Promise<string>; small?: boolean }) {
  const { t, toast, fail } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn excel ${small ? "small" : ""}`}
      title={t("xl.title")}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          toast(t("xl.done", { p: await run() }));
        } catch (err) {
          fail(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      📗 {busy ? t("xl.working") : t("xl.button")}
    </button>
  );
}
