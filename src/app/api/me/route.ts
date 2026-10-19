import { apiError, requireIdentity } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(request.headers);
    return Response.json(identity, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
