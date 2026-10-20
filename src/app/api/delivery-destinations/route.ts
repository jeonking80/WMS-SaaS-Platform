import { destinationCollection } from "@/server/delivery-destinations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return destinationCollection(request); }
export async function POST(request: Request) { return destinationCollection(request); }
