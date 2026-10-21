"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export function useTerminalLock(minutes: number, userKey: string) {
  const [locked, setLocked] = useState(false),
    [warning, setWarning] = useState<number | null>(null),
    [error, setError] = useState("");
  const lastActivity = useRef(Date.now()),
    lockedRef = useRef(false),
    loggingOut = useRef(false);
  const lockKey = `${userKey}:terminal-locked`;
  const logout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    setError("");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      try {
        localStorage.removeItem(lockKey);
      } catch {}
      window.location.replace("/login");
    } catch {
      setError("세션 종료를 확인하지 못해 단말을 잠근 상태로 유지합니다. 연결이 복구되면 다시 종료합니다.");
    } finally {
      loggingOut.current = false;
    }
  }, [lockKey]);
  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setLocked(true);
    setWarning(null);
    try {
      localStorage.setItem(lockKey, "1");
    } catch {
      /* The screen remains locked even when browser storage is unavailable. */
    }
    void logout();
  }, [lockKey, logout]);
  const resume = useCallback(() => {
    if (!lockedRef.current) {
      lastActivity.current = Date.now();
      setWarning(null);
    }
  }, []);
  useEffect(() => {
    try {
      if (localStorage.getItem(lockKey) === "1") lock();
    } catch {}
    lastActivity.current = Date.now();
    const activity = () => {
      if (!lockedRef.current) lastActivity.current = Date.now();
    };
    const online = () => {
      if (lockedRef.current) void logout();
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"];
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    window.addEventListener("online", online);
    const timer = window.setInterval(() => {
      if (lockedRef.current) return;
      const remaining = Math.ceil((Math.max(1, minutes) * 60_000 - (Date.now() - lastActivity.current)) / 1000);
      if (remaining <= 0) lock();
      else setWarning(remaining <= 60 ? remaining : null);
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const event of events) window.removeEventListener(event, activity);
      window.removeEventListener("online", online);
    };
  }, [minutes, lockKey, lock, logout]);
  return { locked, warning, error, resume, lock, logout };
}
export function LockedTerminal({ error, retry }: { error: string; retry: () => void }) {
  const [ready, setReady] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setReady(true);
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (workspace) workspace.inert = true;
    return () => {
      if (workspace) workspace.inert = false;
    };
  }, []);
  useEffect(() => {
    if (ready) button.current?.focus();
  }, [ready]);
  if (!ready) return null;
  return createPortal(
    <div
      className="v2"
      role="dialog"
      aria-modal="true"
      aria-label="공용 단말 잠금"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "#edf3fa",
        display: "grid",
        placeItems: "center",
        maxWidth: "none",
        padding: 24,
      }}
    >
      <section className="v2-card" style={{ maxWidth: 520 }}>
        <h1>공용 단말이 잠겼습니다</h1>
        <p>
          일정 시간 활동이 없어 화면을 숨기고 세션을 종료합니다. 저장된 미확인 요청은 같은 계정으로 다시 로그인한 뒤
          원래 요청으로 복구합니다.
        </p>
        {error && (
          <p role="alert" className="v2-alert">
            {error}
          </p>
        )}
        <button ref={button} className="v2-primary" onClick={retry}>
          세션 종료 확인·로그인으로 이동
        </button>
      </section>
    </div>,
    document.body,
  );
}
