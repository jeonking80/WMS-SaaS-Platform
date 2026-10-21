import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/server/auth/access";
import Stock from "./ui";

export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [identity, params] = await Promise.all([getCurrentIdentity(new Headers(await headers())), searchParams]);
  if (!identity) redirect("/login");
  const initialFilters = Object.fromEntries(["item_id", "warehouse_id", "location_id"].map(key => [key, typeof params[key] === "string" ? params[key] : ""]));
  return <Stock role={identity.role} initialFilters={initialFilters} />;
}
