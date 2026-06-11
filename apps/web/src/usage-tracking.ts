import { useEffect, useMemo, useRef } from "react";
import { API_BASE } from "./api";

type UsageTrackingOptions = {
  enabled: boolean;
  page: string;
  userId?: number | null;
  farmId?: number | null;
};

type UsageEvent = {
  eventType: string;
  page: string;
  path: string;
  title?: string | null;
  occurredAt: string;
  durationMs?: number | null;
  details?: Record<string, unknown>;
};

const ANONYMOUS_ID_STORAGE_KEY = "loam-ledger-usage-anonymous-id";
const MAX_CLICK_LABEL_LENGTH = 120;
const MAX_CLICK_EVENTS_PER_MINUTE = 60;

let clickWindowStartedAt = 0;
let clickWindowCount = 0;

function randomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readAnonymousId() {
  if (typeof window === "undefined") {
    return null;
  }

  const existing = window.localStorage.getItem(ANONYMOUS_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const next = randomId();
  window.localStorage.setItem(ANONYMOUS_ID_STORAGE_KEY, next);
  return next;
}

function currentPath() {
  if (typeof window === "undefined") {
    return "/";
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function viewportDetails() {
  if (typeof window === "undefined") {
    return {};
  }
  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    visibilityState: typeof document === "undefined" ? null : document.visibilityState
  };
}

function sendUsageEvent(
  anonymousId: string | null,
  browserSessionId: string,
  event: UsageEvent,
  preferBeacon = false
) {
  const payload = JSON.stringify({
    anonymousId,
    browserSessionId,
    ...event
  });

  if (preferBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      `${API_BASE}/api/usage/events`,
      new Blob([payload], { type: "application/json" })
    );
    if (sent) {
      return;
    }
  }

  void fetch(`${API_BASE}/api/usage/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "include",
    body: payload,
    keepalive: preferBeacon
  }).catch(() => {
    // Usage tracking should never interrupt farm work.
  });
}

function clickLabel(target: Element) {
  const interactive = target.closest("button,a,input,select,textarea,[role='button']");
  if (!interactive) {
    return null;
  }

  const explicit = interactive.getAttribute("aria-label") || interactive.getAttribute("title");
  const text = explicit || interactive.textContent || interactive.getAttribute("name") || interactive.getAttribute("type") || "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CLICK_LABEL_LENGTH) || interactive.tagName.toLowerCase();
}

function clickTargetDetails(target: Element) {
  const interactive = target.closest("button,a,input,select,textarea,[role='button']");
  if (!interactive) {
    return null;
  }
  return {
    tag: interactive.tagName.toLowerCase(),
    label: clickLabel(target),
    type: interactive.getAttribute("type"),
    name: interactive.getAttribute("name"),
    href: interactive instanceof HTMLAnchorElement ? interactive.pathname : null
  };
}

function canRecordClick(now: number) {
  if (now - clickWindowStartedAt > 60_000) {
    clickWindowStartedAt = now;
    clickWindowCount = 0;
  }
  clickWindowCount += 1;
  return clickWindowCount <= MAX_CLICK_EVENTS_PER_MINUTE;
}

export function useUsageTracking({ enabled, page, userId, farmId }: UsageTrackingOptions) {
  const anonymousId = useMemo(() => readAnonymousId(), []);
  const browserSessionId = useMemo(() => randomId(), []);
  const activePageRef = useRef({
    page,
    path: currentPath(),
    enteredAt: Date.now()
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const previous = activePageRef.current;
    const now = Date.now();
    if (previous.page !== page || previous.path !== currentPath()) {
      sendUsageEvent(anonymousId, browserSessionId, {
        eventType: "page_leave",
        page: previous.page,
        path: previous.path,
        title: typeof document === "undefined" ? null : document.title,
        occurredAt: new Date(now).toISOString(),
        durationMs: Math.max(0, now - previous.enteredAt),
        details: viewportDetails()
      });
    }

    activePageRef.current = {
      page,
      path: currentPath(),
      enteredAt: now
    };

    sendUsageEvent(anonymousId, browserSessionId, {
      eventType: "page_view",
      page,
      path: currentPath(),
      title: typeof document === "undefined" ? null : document.title,
      occurredAt: new Date(now).toISOString(),
      details: {
        ...viewportDetails(),
        userId: userId ?? null,
        farmId: farmId ?? null
      }
    });
  }, [anonymousId, browserSessionId, enabled, farmId, page, userId]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const flushCurrentPage = (eventType: string, preferBeacon = true) => {
      const active = activePageRef.current;
      const now = Date.now();
      sendUsageEvent(anonymousId, browserSessionId, {
        eventType,
        page: active.page,
        path: active.path,
        title: typeof document === "undefined" ? null : document.title,
        occurredAt: new Date(now).toISOString(),
        durationMs: Math.max(0, now - active.enteredAt),
        details: viewportDetails()
      }, preferBeacon);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushCurrentPage("visibility_hidden");
      } else {
        const active = activePageRef.current;
        activePageRef.current = {
          page: active.page,
          path: currentPath(),
          enteredAt: Date.now()
        };
        sendUsageEvent(anonymousId, browserSessionId, {
          eventType: "visibility_visible",
          page: active.page,
          path: currentPath(),
          title: document.title,
          occurredAt: new Date().toISOString(),
          details: viewportDetails()
        });
      }
    };

    const onPageHide = () => flushCurrentPage("page_hide");

    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !canRecordClick(Date.now())) {
        return;
      }
      const details = clickTargetDetails(event.target);
      if (!details) {
        return;
      }
      sendUsageEvent(anonymousId, browserSessionId, {
        eventType: "click",
        page: activePageRef.current.page,
        path: currentPath(),
        title: document.title,
        occurredAt: new Date().toISOString(),
        details: {
          ...details,
          ...viewportDetails()
        }
      });
    };

    const onError = (event: ErrorEvent) => {
      sendUsageEvent(anonymousId, browserSessionId, {
        eventType: "frontend_error",
        page: activePageRef.current.page,
        path: currentPath(),
        title: document.title,
        occurredAt: new Date().toISOString(),
        details: {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        }
      }, true);
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      sendUsageEvent(anonymousId, browserSessionId, {
        eventType: "frontend_unhandled_rejection",
        page: activePageRef.current.page,
        path: currentPath(),
        title: document.title,
        occurredAt: new Date().toISOString(),
        details: {
          reason: event.reason instanceof Error ? event.reason.message : String(event.reason)
        }
      }, true);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      flushCurrentPage("tracker_stopped");
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [anonymousId, browserSessionId, enabled]);
}
