"use client";
import { usePathname } from "next/navigation";
// The v2 operations screen draws its own menu and top bar; other pages keep the shared workspace chrome.
export default function WorkspaceFrame({ sidebar, topbar, children }: { sidebar: React.ReactNode; topbar: React.ReactNode; children: React.ReactNode }) {
 const pathname = usePathname();
 if (pathname.startsWith("/dashboard/v2")) return <main id="workspace-content" className="workspace-full">{children}</main>;
 return <div className="workspace"><a className="skip-link" href="#workspace-content">본문으로 이동</a>{sidebar}<div className="workspace-body">{topbar}<main id="workspace-content" className="workspace-content">{children}</main></div></div>;
}
