import { useEffect, useState } from "preact/hooks";

/** The current time, refreshed every few seconds so "x min ago" stays true without a reload. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
