import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LocalSqlite } from "./helpers.ts";
import { parseSnapshot, drawSample } from "../lib/audit/dataset.ts";
import { createProject, getReviewItem, importSnapshot, initialize, projectDetails, snapshotRaw } from "../lib/audit/store.ts";
import { DEFAULT_REVISION } from "../lib/audit/types.ts";

test("pinned public benchmark imports intact and creates a reproducible 400-example project", async () => {
  const raw = await readFile("data/huggingface_supported_grac_metadata.jsonl", "utf8");
  const parsed = await parseSnapshot(raw, DEFAULT_REVISION);
  assert.equal(parsed.meta.population, 13310); assert.equal(parsed.meta.senses, 3206); assert.equal(parsed.meta.lemmas, 1386);
  const local = new LocalSqlite(), db = local.asD1();
  try {
    await initialize(db);
    const meta = await importSnapshot(db, raw, DEFAULT_REVISION, parsed);
    assert.equal(await snapshotRaw(db, meta.id), raw);
    const project = await createProject(db, { snapshotId: meta.id, name: "Реальний бенчмарк", reviewer: "Тест", seed: "42", sampleSize: 400 });
    const details = await projectDetails(db, project.id);
    assert.equal(details.queue.length, 400);
    assert.deepEqual(details.queue.map(s => s.exampleId), (await drawSample(parsed, 400, "42")).map(s => s.exampleId));
    for (const entry of details.queue.slice(0, 10)) {
      const item = await getReviewItem(db, project.id, entry.exampleId);
      assert.equal(item.assignedSenseId, undefined);
      assert.equal(item.options.length, parsed.senses.filter(s => s.lemma === item.lemma).length);
    }
    console.log(`Verified ${meta.population} examples; SHA-256 ${meta.checksum}`);
  } finally { local.close(); }
});
