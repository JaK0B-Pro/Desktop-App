import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

/** The installed app version (from tauri.conf.json), e.g. "0.4.0". */
export function useAppVersion(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setV)
      .catch(() => setV(null));
  }, []);
  return v;
}
