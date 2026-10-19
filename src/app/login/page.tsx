import Link from "next/link";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="mx-auto max-w-md px-6 py-16 sm:py-24">
      <Link href="/" className="text-sm font-semibold text-blue-800">WMS Lite</Link>
      <h1 className="mt-6 text-3xl font-bold">로그인</h1>
      <p className="mt-3 leading-7 text-slate-600">회사에서 발급받은 계정으로 로그인하세요.</p>
      <LoginForm />
      <p className="mt-6 text-sm leading-6 text-slate-600">계정 발급이나 접근 권한은 회사 관리자에게 문의하세요.</p>
    </main>
  );
}
