import { masterCollection } from "@/server/master-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) { return masterCollection(request, "items"); }
export async function POST(request: Request) { return masterCollection(request, "items"); }
