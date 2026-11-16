import { env } from "cloudflare:workers";
import { handleAuditRequest } from "../../../lib/audit/http.ts";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  if (!env.DB) return Response.json({ error: "Локальну базу не підключено. Перевірте d1: DB у .openai/hosting.json." }, { status: 500 });
  return handleAuditRequest(request, (await context.params).path, env.DB);
}
export const GET = handle;
export const POST = handle;
