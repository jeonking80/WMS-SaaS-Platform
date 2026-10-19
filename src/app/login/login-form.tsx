"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      if (!response.ok) {
        setError("로그인할 수 없습니다. 이메일과 비밀번호를 확인한 후 다시 시도하세요.");
        return;
      }
      const identity = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (!identity.ok) {
        setError("회사 접근 권한을 확인할 수 없습니다. 관리자에게 문의하세요.");
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5 rounded-2xl border border-slate-200 bg-white p-6" aria-busy={pending}>
      <div>
        <label htmlFor="email" className="block text-sm font-semibold">이메일</label>
        <input id="email" name="email" type="email" autoComplete="username" required disabled={pending} className="mt-2 w-full rounded-lg border border-slate-300 p-3 focus:outline-2 focus:outline-blue-700" />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-semibold">비밀번호</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} className="mt-2 w-full rounded-lg border border-slate-300 p-3 focus:outline-2 focus:outline-blue-700" />
      </div>
      {error && <p role="alert" className="text-sm leading-6 text-red-700">{error}</p>}
      <button type="submit" disabled={pending} className="w-full rounded-lg bg-blue-800 px-4 py-3 font-semibold text-white hover:bg-blue-900 disabled:opacity-60">{pending ? "로그인 중…" : "로그인"}</button>
    </form>
  );
}
