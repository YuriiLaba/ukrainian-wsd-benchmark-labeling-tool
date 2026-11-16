import { AuditError, DEFAULT_REVISION, REPOSITORY, SOURCE_FILE } from "./types.ts";
import { createProject, getReviewItem, importSnapshot, initialize, listProjects, listSnapshots, projectDetails, projectResults, reveal, saveAssessment, setPosition } from "./store.ts";
import { exportBackup, exportCsv, reportMarkdown, restoreBackup } from "./exports.ts";

function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function attachment(body: string, type: string, name: string) {
  return new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
export async function handleAuditRequest(request: Request, path: string[], db: D1Database) {
  try {
    await initialize(db);
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (path.length === 1 && path[0] === "snapshots") return json(await listSnapshots(db));
      if (path.length === 1 && path[0] === "projects") return json(await listProjects(db));
      if (path[0] === "projects" && path[1]) {
        const id = path[1];
        if (path.length === 2) return json(await projectDetails(db, id));
        if (path.length === 4 && path[2] === "items") return json(await getReviewItem(db, id, path[3]));
        if (path.length === 3 && path[2] === "results") return json(await projectResults(db, id));
        if (path.length === 3 && path[2] === "report") return json(await reportMarkdown(db, id));
        if (path.length === 3 && path[2] === "export") {
          const format = url.searchParams.get("format");
          if (format === "csv") return attachment(await exportCsv(db, id), "text/csv; charset=utf-8", `wsd-${id}.csv`);
          if (format === "backup") return attachment(JSON.stringify(await exportBackup(db, id)), "application/json; charset=utf-8", `wsd-${id}-backup.json`);
          if (format === "results") return attachment(JSON.stringify(await projectResults(db, id), null, 2), "application/json; charset=utf-8", `wsd-${id}-results.json`);
          if (format === "markdown") return attachment((await reportMarkdown(db, id)).markdown, "text/markdown; charset=utf-8", `wsd-${id}-report.md`);
        }
      }
    }
    if (request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) throw new AuditError("Запит має походити з локального застосунку.", 403);
      if (Number(request.headers.get("Content-Length") ?? 0) > 180 * 1024 * 1024) throw new AuditError("Файл завеликий.", 413);
      let input: Record<string, unknown>;
      try { input = await request.json() as Record<string, unknown>; } catch { throw new AuditError("Не вдалося прочитати JSON запиту."); }
      if (!input || typeof input !== "object") throw new AuditError("Некоректний запит.");
      if (path.length === 1 && path[0] === "snapshots") {
        if (typeof input.raw !== "string") throw new AuditError("Оберіть JSONL файл.");
        return json(await importSnapshot(db, input.raw, null), 201);
      }
      if (path.length === 2 && path[0] === "snapshots" && path[1] === "download") {
        const revision = input.revision ?? DEFAULT_REVISION;
        if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) throw new AuditError("Потрібен повний 40-символьний commit SHA Hugging Face.");
        let response: Response;
        try { response = await fetch(`https://huggingface.co/datasets/${REPOSITORY}/resolve/${revision}/${SOURCE_FILE}`, { signal: AbortSignal.timeout(180_000) }); }
        catch { throw new AuditError("Не вдалося завантажити з Hugging Face. Спробуйте ще раз або імпортуйте JSONL файл.", 502); }
        if (!response.ok) throw new AuditError(`Hugging Face повернув HTTP ${response.status}. Спробуйте імпортувати JSONL файл.`, 502);
        return json(await importSnapshot(db, await response.text(), revision), 201);
      }
      if (path.length === 1 && path[0] === "restore") return json(await restoreBackup(db, input), 201);
      if (path.length === 1 && path[0] === "projects") return json(await createProject(db, input as Parameters<typeof createProject>[1]), 201);
      if (path[0] === "projects" && path[1]) {
        if (path.length === 3 && path[2] === "position") { await setPosition(db, path[1], input.position as number); return json({ saved: true }); }
        if (path.length === 5 && path[2] === "items" && path[4] === "reveal") return json(await reveal(db, path[1], path[3], input.choice, input.version));
        if (path.length === 5 && path[2] === "items" && path[4] === "assessment") return json(await saveAssessment(db, path[1], path[3], input.assessment, input.version));
      }
    }
    throw new AuditError("Маршрут не знайдено.", 404);
  } catch (error) {
    if (error instanceof AuditError) return json({ error: error.message }, error.status);
    console.error("Local audit API error", error);
    return json({ error: "Не вдалося виконати операцію. Зміни не підтверджено; повторіть спробу. Подробиці — у терміналі застосунку." }, 500);
  }
}
