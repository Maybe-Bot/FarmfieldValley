import { useEffect, useRef } from "react";
import { api } from "./api";

type UsageTrackingOptions = {
  enabled: boolean;
  page: string;
};

function record(eventType: "page_view" | "page_leave", page: string, durationSeconds?: number) {
  void api.recordUsageEvent({ eventType, page, durationSeconds }).catch(() => {
    // Optional usage tracking must never interrupt farm work.
  });
}

export function useUsageTracking({ enabled, page }: UsageTrackingOptions) {
  const activePageRef = useRef({ page, enteredAt: Date.now() });

  useEffect(() => {
    // Remove the identifier created by the previous tracker implementation.
    window.localStorage.removeItem("loam-ledger-usage-anonymous-id");
  }, []);

  useEffect(() => {
    const now = Date.now();
    const previous = activePageRef.current;

    if (!enabled) {
      activePageRef.current = { page, enteredAt: now };
      return;
    }

    if (previous.page !== page) {
      record("page_leave", previous.page, Math.max(0, (now - previous.enteredAt) / 1000));
    }
    activePageRef.current = { page, enteredAt: now };
    record("page_view", page);
  }, [enabled, page]);

  useEffect(() => {
    if (!enabled) return;
    return () => {
      const active = activePageRef.current;
      record("page_leave", active.page, Math.max(0, (Date.now() - active.enteredAt) / 1000));
    };
  }, [enabled]);
}
