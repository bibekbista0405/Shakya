"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const PRIMARY_ROUTES = ["/chats", "/calls", "/friends", "/notifications", "/profile", "/settings"];

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/** Warm primary routes gradually after the browser settles, without request bursts. */
export function useRouteWarmup(): void {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    const idleWindow = window as IdleWindow;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;

    const run = () => {
      if (cancelled) return;
      let index = 0;
      const warmNext = () => {
        if (cancelled || index >= PRIMARY_ROUTES.length) return;
        const route = PRIMARY_ROUTES[index++];
        if (route !== window.location.pathname) router.prefetch(route);
        timer = setTimeout(warmNext, 700);
      };
      warmNext();
    };

    timer = setTimeout(() => {
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(run, { timeout: 1500 });
      else run();
    }, 900);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [router]);
}
