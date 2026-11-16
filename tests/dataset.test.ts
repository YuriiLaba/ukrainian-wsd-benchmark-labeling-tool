import { test } from "node:test";
import assert from "node:assert/strict";
import { drawSample, parseSnapshot } from "../lib/audit/dataset.ts";
import { fixtureRaw } from "./helpers.ts";

test("import preserves text and metadata and assigns snapshot-dependent stable identities", async () => {
  const a = await parseSnapshot(fixtureRaw), b = await parseSnapshot(fixtureRaw);
  assert.equal(a.meta.population, 10); assert.equal(a.meta.senses, 4); assert.equal(a.meta.lemmas, 2);
  assert.deepEqual(a.examples, b.examples);
  assert.equal(a.examples[0].sentence, "Майстер полагодив замок.");
  assert.equal(a.examples[0].grac.document_id, "d1");
  assert.equal(a.examples[0].index, 0); assert.equal(a.examples[1].index, 1);
  assert.notEqual((await parseSnapshot(fixtureRaw + "\n")).examples[0].id, a.examples[0].id);
});
test("sample is unique and reproducible; every item has every sense for its lemma", async () => {
  const snapshot = await parseSnapshot(fixtureRaw);
  const a = await drawSample(snapshot, 7, "42"), b = await drawSample(snapshot, 7, "42"), c = await drawSample(snapshot, 7, "43");
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.equal(a.length, 7); assert.equal(new Set(a.map(e => e.exampleId)).size, 7);
  for (const item of a) {
    const example = snapshot.examples.find(e => e.id === item.exampleId)!;
    const lemma = snapshot.senses.find(s => s.id === example.senseId)!.lemma;
    assert.deepEqual([...item.optionIds].sort(), snapshot.senses.filter(s => s.lemma === lemma).map(s => s.id).sort());
  }
  assert.equal((await drawSample(snapshot, 10, "seed")).length, 10);
  await assert.rejects(drawSample(snapshot, 11, "42"));
  await assert.rejects(drawSample(snapshot, 0, "42"));
  await assert.rejects(drawSample(snapshot, 2, ""));
});
test("duplicate sentence assignments remain separate population units", async () => {
  const row = JSON.parse(fixtureRaw.split("\n")[0]); row.examples.push(row.examples[0]);
  const snapshot = await parseSnapshot(JSON.stringify(row));
  assert.equal(snapshot.meta.population, 4);
  assert.equal(snapshot.examples[0].sentence, snapshot.examples[3].sentence);
  assert.notEqual(snapshot.examples[0].id, snapshot.examples[3].id);
});
test("malformed inputs fail instead of silently dropping records", async () => {
  for (const raw of ["", "{bad}", '{"lemma":"а","gloss":[],"examples":[]}', '{"lemma":"а","gloss":["значення"],"examples":[{"sentence":""}]}']) await assert.rejects(parseSnapshot(raw));
});
