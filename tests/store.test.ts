import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalSqlite, fixtureRaw } from "./helpers.ts";
import { createProject, getReviewItem, getSample, importSnapshot, initialize, listProjects, listSnapshots, projectDetails, projectResults, reveal, saveAssessment, snapshotRaw } from "../lib/audit/store.ts";
import { parseSnapshot } from "../lib/audit/dataset.ts";
import { exportBackup, exportCsv, reportMarkdown, restoreBackup } from "../lib/audit/exports.ts";
import type { Assessment } from "../lib/audit/types.ts";

async function setup(path?: string, sampleSize = 7) {
  const local = new LocalSqlite(path), db = local.asD1();
  await initialize(db);
  const meta = await importSnapshot(db, fixtureRaw, "a".repeat(40));
  const project = await createProject(db, { snapshotId: meta.id, name: "Тестова перевірка", reviewer: "Перевіряльник", seed: "42", sampleSize });
  return { local, db, meta, project, details: await projectDetails(db, project.id) };
}
const correct: Assessment = { verdict: "correct", reason: "", replacementSenseId: null, notes: "Підтверджено." };
test("raw snapshot chunks preserve Unicode surrogate pairs at a storage boundary", async () => {
  const local = new LocalSqlite(), db = local.asD1();
  try {
    await initialize(db);
    const prefix = '{"lemma":"тест","gloss":["значення"],"examples":[{"sentence":"';
    const raw = prefix + "я".repeat(65535 - prefix.length) + '🌻","grac":{}}]}\n';
    const meta = await importSnapshot(db, raw);
    assert.equal(await snapshotRaw(db, meta.id), raw);
  } finally { local.close(); }
});
test("an interrupted import can be retried after its stale-import grace period", async () => {
  const local = new LocalSqlite(), db = local.asD1();
  try {
    await initialize(db);
    const parsed = await parseSnapshot(fixtureRaw);
    await db.prepare("INSERT INTO snapshots(id,metadata,status) VALUES(?,?,'importing')").bind(parsed.meta.id, JSON.stringify(parsed.meta)).run();
    await assert.rejects(importSnapshot(db, fixtureRaw), /10 хвилин/);
    await db.prepare("UPDATE snapshots SET metadata=? WHERE id=?").bind(JSON.stringify({ ...parsed.meta, importedAt: "2000-01-01T00:00:00.000Z" }), parsed.meta.id).run();
    assert.equal((await importSnapshot(db, fixtureRaw)).population, 10);
    assert.equal(await snapshotRaw(db, parsed.meta.id), fixtureRaw);
  } finally { local.close(); }
});
test("blind API excludes labels, locators and row indices until a durable reveal", async () => {
  const { local, db, project, details } = await setup();
  try {
    const id = details.queue[0].exampleId;
    const item = await getReviewItem(db, project.id, id);
    assert.equal(item.options.length, 2); assert.equal(item.blindChoice, null);
    for (const key of ["assignedSenseId", "grac", "row", "senseId", "history"]) assert.equal(key in item, false);
    assert.equal(JSON.stringify(details).includes("assignedSenseId"), false);
    await assert.rejects(saveAssessment(db, project.id, id, correct, 0));
    local.failNextWrite = true;
    await assert.rejects(reveal(db, project.id, id, item.options[0].id, 0));
    assert.equal((await getSample(db, project.id, id)).revealedAt, null);
    const revealed = await reveal(db, project.id, id, item.options[0].id, 0);
    assert.ok(revealed.assignedSenseId); assert.ok(revealed.grac); assert.equal(revealed.version, 1); assert.equal(revealed.history?.length, 1);
    assert.equal((await reveal(db, project.id, id, item.options[0].id, 0)).version, 1);
    await assert.rejects(reveal(db, project.id, id, item.options[1].id, 1));
    const saved = await saveAssessment(db, project.id, id, correct, 1);
    assert.equal(saved.version, 2); assert.equal(saved.blindChoice, item.options[0].id); assert.equal(saved.history?.length, 2);
    await assert.rejects(saveAssessment(db, project.id, id, correct, 1));
    local.failNextWrite = true;
    await assert.rejects(saveAssessment(db, project.id, id, { ...correct, notes: "Втрачений запис" }, 2));
    assert.equal((await getReviewItem(db, project.id, id)).assessment?.notes, correct.notes);
    assert.equal((await getReviewItem(db, project.id, id)).history?.length, 2);
    const edited = await saveAssessment(db, project.id, id, { verdict: "unresolved", reason: "overlapping_senses", replacementSenseId: null, notes: "Переглянуто після відкриття." }, 2);
    assert.equal(edited.version, 3); assert.equal(edited.blindChoice, item.options[0].id); assert.equal(edited.history?.length, 3);
  } finally { local.close(); }
});
test("snapshot deduplication and immutable project settings preserve the fixed sample", async () => {
  const { local, db, meta, project, details } = await setup();
  try {
    await importSnapshot(db, fixtureRaw);
    assert.equal((await listSnapshots(db)).length, 1);
    const other = await createProject(db, { snapshotId: meta.id, name: "Другий", reviewer: "Автор", seed: project.seed, sampleSize: project.sampleSize });
    assert.notEqual(other.id, project.id);
    assert.deepEqual((await projectDetails(db, other.id)).queue.map(q => q.exampleId), details.queue.map(q => q.exampleId));
    assert.equal((await listProjects(db)).length, 2);
    await assert.rejects(getReviewItem(db, project.id, "outside-sample"));
  } finally { local.close(); }
});
test("all sample members, including unresolved cases, remain in the final denominator", async () => {
  const { local, db, project, details } = await setup(undefined, 3);
  try {
    assert.equal((await projectResults(db, project.id)).interval, null);
    await assert.rejects(reportMarkdown(db, project.id));
    for (let i = 0; i < details.queue.length; i++) {
      const id = details.queue[i].exampleId;
      const item = await reveal(db, project.id, id, "uncertain", 0);
      const a: Assessment = i === 0 ? correct : i === 1 ? { verdict: "incorrect", reason: "no_matching_definition", replacementSenseId: null, notes: "" } : { verdict: "unresolved", reason: "insufficient_context", replacementSenseId: null, notes: "" };
      await saveAssessment(db, project.id, id, a, item.version);
    }
    const r = await projectResults(db, project.id);
    assert.equal(r.complete, true); assert.deepEqual(r.counts, { correct: 1, incorrect: 1, unresolved: 1, pending: 0 });
    assert.equal(r.confirmedProportion, 1 / 3); assert.equal(r.unresolvedReasons.insufficient_context, 1); assert.ok(r.interval);
    const report = await reportMarkdown(db, project.id);
    assert.match(report.paragraph, /33,33%/); assert.match(report.markdown, /міжанотаторну/);
  } finally { local.close(); }
});
test("invalid verdict/replacement combinations fail without changing history", async () => {
  const { local, db, project, details } = await setup();
  try {
    const id = details.queue[0].exampleId, revealed = await reveal(db, project.id, id, "none", 0);
    for (const assessment of [{ ...correct, verdict: "unresolved", reason: "" }, { ...correct, replacementSenseId: revealed.assignedSenseId }, { ...correct, verdict: "incorrect", replacementSenseId: "foreign-sense" }, { ...correct, notes: "x".repeat(10001) }]) await assert.rejects(saveAssessment(db, project.id, id, assessment, 1));
    assert.equal((await getReviewItem(db, project.id, id)).history?.length, 1);
  } finally { local.close(); }
});
test("backup round-trip preserves sample, immutable initial judgments and edit history", async () => {
  const { local, db, project, details } = await setup();
  const target = new LocalSqlite(), targetDb = target.asD1();
  try {
    const id = details.queue[0].exampleId;
    await reveal(db, project.id, id, "none", 0);
    await saveAssessment(db, project.id, id, correct, 1);
    await saveAssessment(db, project.id, id, { ...correct, notes: "Виправлено примітку" }, 2);
    const backup = await exportBackup(db, project.id);
    await initialize(targetDb);
    const restored = await restoreBackup(targetDb, backup);
    assert.notEqual(restored.id, project.id);
    const item = await getReviewItem(targetDb, restored.id, id);
    assert.equal(item.blindChoice, "none"); assert.equal(item.assessment?.notes, "Виправлено примітку"); assert.equal(item.history?.length, 3);
    assert.deepEqual((await projectDetails(targetDb, restored.id)).queue, details.queue.map((q, i) => i ? q : { ...q, verdict: "correct", revealed: true }));
    const pristine = new LocalSqlite(), pristineDb = pristine.asD1(); await initialize(pristineDb);
    try {
      for (const mutate of [(b: typeof backup) => { b.source.raw += " "; }, (b: typeof backup) => { b.project.seed = "different"; }, (b: typeof backup) => { b.samples[0].blindChoice = "uncertain"; }, (b: typeof backup) => { b.history.pop(); }, (b: typeof backup) => { b.samples[1].exampleId = b.samples[0].exampleId; }]) {
        const broken = structuredClone(backup); mutate(broken);
        await assert.rejects(restoreBackup(pristineDb, broken));
        assert.equal((await listSnapshots(pristineDb)).length, 0); assert.equal((await listProjects(pristineDb)).length, 0);
      }
    } finally { pristine.close(); }
  } finally { local.close(); target.close(); }
});
test("CSV round trip contains Ukrainian and quotes; unrevealed assignments stay blank", async () => {
  const { local, db, project, details } = await setup(undefined, 2);
  try {
    const before = await exportCsv(db, project.id);
    assert.ok(before.startsWith("\uFEFF")); assert.ok(before.includes("sentence"));
    assert.ok(!before.includes('"пристрій для замикання дверей"'));
    assert.ok(!before.includes('"укріплена будівля"'));
    await reveal(db, project.id, details.queue[0].exampleId, "none", 0);
    await saveAssessment(db, project.id, details.queue[0].exampleId, { ...correct, notes: '=SUM(1,2)\n"цитата"' }, 1);
    const csv = await exportCsv(db, project.id);
    assert.ok(csv.includes("'=SUM(1,2)\n\"\"цитата\"\""));
    assert.ok(csv.includes("Правильна") === false); // stable machine-readable enums
  } finally { local.close(); }
});
test("saved progress and reveal state survive closing and reopening the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsd-audit-")), path = join(dir, "audit.sqlite");
  try {
    const { local, db, project, details } = await setup(path);
    const id = details.queue[0].exampleId;
    await reveal(db, project.id, id, "uncertain", 0);
    await saveAssessment(db, project.id, id, correct, 1);
    local.close();
    const restarted = new LocalSqlite(path), reopened = restarted.asD1();
    try { await initialize(reopened); const item = await getReviewItem(reopened, project.id, id); assert.equal(item.version, 2); assert.equal(item.blindChoice, "uncertain"); assert.equal(item.assessment?.verdict, "correct"); assert.equal((await listProjects(reopened))[0].completed, 1); }
    finally { restarted.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
