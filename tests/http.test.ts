import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuditRequest } from "../lib/audit/http.ts";
import { LocalSqlite, fixtureRaw } from "./helpers.ts";

test("HTTP workflow enforces reveal, final-report gating and export formats", async () => {
  const local = new LocalSqlite(), db = local.asD1();
  const request = (path: string, body?: unknown) => handleAuditRequest(new Request(`http://localhost:5173/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" }, body: JSON.stringify(body) }), path.split("/"), db);
  try {
    const imported = await request("snapshots", { raw: fixtureRaw });
    assert.equal(imported.status, 201);
    const meta = await imported.json() as { id: string };
    const created = await request("projects", { snapshotId: meta.id, name: "HTTP тест", reviewer: "Автор", seed: "42", sampleSize: 1 });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    const base = `projects/${project.id}`;
    const details = await (await request(base)).json() as { queue: { exampleId: string }[] };
    const path = `${base}/items/${details.queue[0].exampleId}`;
    const hidden = await (await request(path)).json() as { version: number; options: { id: string }[] };
    assert.equal("assignedSenseId" in hidden, false);
    assert.equal((await request(`${base}/report`)).status, 409);
    assert.equal((await request(`${path}/assessment`, { version: 0, assessment: { verdict: "correct", reason: "", replacementSenseId: null, notes: "" } })).status, 409);
    const opened = await request(`${path}/reveal`, { choice: hidden.options[0].id, version: hidden.version });
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("Cache-Control"), "no-store");
    const visible = await opened.json() as { assignedSenseId: string; version: number };
    assert.ok(visible.assignedSenseId);
    assert.equal((await request(`${path}/assessment`, { version: visible.version, assessment: { verdict: "unresolved", reason: "insufficient_context", replacementSenseId: null, notes: "" } })).status, 200);
    assert.equal((await request(`${base}/report`)).status, 200);
    const csv = await handleAuditRequest(new Request(`http://localhost:5173/api/${base}/export?format=csv`), [...base.split("/"), "export"], db);
    assert.equal(csv.status, 200); assert.match(csv.headers.get("Content-Type")!, /text\/csv/); assert.match(csv.headers.get("Content-Disposition")!, /attachment/);
    assert.equal((await request("not-a-route")).status, 404);
    assert.equal((await request("projects", {})).status, 400);
    assert.equal((await request("restore", { version: 99 })).status, 400);
    assert.equal((await request("snapshots/download", { revision: "main" })).status, 400);
    const crossOrigin = await handleAuditRequest(new Request("http://localhost:5173/api/projects", { method: "POST", headers: { Origin: "https://example.com" }, body: "{}" }), ["projects"], db);
    assert.equal(crossOrigin.status, 403);
  } finally { local.close(); }
});
