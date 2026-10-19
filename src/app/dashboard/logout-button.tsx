"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setError("로그아웃하지 못했습니다. 다시 시도하세요.");
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setError("서버에 연결할 수 없습니다. 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button onClick={logout} disabled={pending} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-60">{pending ? "로그아웃 중…" : "로그아웃"}</button>
      {error && <p role="alert" className="mt-2 max-w-xs text-sm text-red-700">{error}</p>}
    </div>
  );
}
