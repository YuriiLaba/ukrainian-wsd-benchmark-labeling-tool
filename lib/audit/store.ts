import { parseSnapshot, drawSample } from "./dataset.ts";
import { SCHEMA } from "./schema.ts";
import { finitePopulationInterval, planningMargin } from "./statistics.ts";
import { AuditError, REASONS, SAMPLER, SPECIAL_CHOICES, VERDICTS } from "./types.ts";
import type { Assessment, Example, History, ParsedSnapshot, Project, ProjectSummary, QueueItem, ReviewItem, Sample, Sense, SnapshotMeta } from "./types.ts";

const initialized = new WeakMap<object, Promise<void>>();
export async function initialize(db: D1Database) {
  let ready = initialized.get(db);
  if (!ready) {
    ready = (async () => { for (const sql of SCHEMA) await db.prepare(sql).run(); })();
    initialized.set(db, ready);
    ready.catch(() => initialized.delete(db));
  }
  await ready;
}
async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
async function batches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let offset = 0; offset < statements.length; offset += 40) await db.batch(statements.slice(offset, offset + 40));
}
const projectColumns = "id,snapshot_id AS snapshotId,name,reviewer,seed,sample_size AS sampleSize,sampler,created_at AS createdAt,last_position AS lastPosition";
const sampleColumns = "project_id AS projectId,position,example_id AS exampleId,option_ids AS optionIds,blind_choice AS blindChoice,revealed_at AS revealedAt,verdict,reason,replacement_sense_id AS replacementSenseId,notes,updated_at AS updatedAt,version";
type RawSample = Omit<Sample, "optionIds"> & { optionIds: string };
function sampleFromRow(s: RawSample): Sample { return { ...s, optionIds: JSON.parse(s.optionIds) }; }

export async function listSnapshots(db: D1Database): Promise<SnapshotMeta[]> {
  return (await all<{ metadata: string }>(db, "SELECT metadata FROM snapshots WHERE status='ready' ORDER BY rowid DESC")).map(r => JSON.parse(r.metadata));
}
export async function snapshotMeta(db: D1Database, id: string): Promise<SnapshotMeta> {
  const row = await db.prepare("SELECT metadata FROM snapshots WHERE id=? AND status='ready'").bind(id).first<{ metadata: string }>();
  if (!row) throw new AuditError("Знімок даних не знайдено.", 404);
  return JSON.parse(row.metadata);
}
export async function snapshotRaw(db: D1Database, id: string) {
  await snapshotMeta(db, id);
  return (await all<{ content: string }>(db, "SELECT content FROM source_chunks WHERE snapshot_id=? ORDER BY ordinal", id)).map(r => r.content).join("");
}
export async function importSnapshot(db: D1Database, raw: string, revision: string | null = null, parsed?: ParsedSnapshot) {
  const snapshot = parsed ?? await parseSnapshot(raw, revision);
  const existing = await db.prepare("SELECT metadata,status FROM snapshots WHERE id=?").bind(snapshot.meta.id).first<{ metadata: string; status: string }>();
  if (existing?.status === "ready") return JSON.parse(existing.metadata) as SnapshotMeta;
  if (existing) {
    const importedAt = Date.parse(JSON.parse(existing.metadata).importedAt);
    if (Date.now() - importedAt < 10 * 60_000) throw new AuditError("Цей знімок ще імпортується. Якщо імпорт перервався, повторіть його через 10 хвилин — незавершені дані буде очищено.", 409);
    await db.prepare("DELETE FROM snapshots WHERE id=? AND status='importing'").bind(snapshot.meta.id).run();
  }
  await db.prepare("INSERT INTO snapshots(id,metadata) VALUES(?,?)").bind(snapshot.meta.id, JSON.stringify(snapshot.meta)).run();
  try {
    const chunks: D1PreparedStatement[] = [];
    for (let i = 0, ordinal = 0; i < raw.length; ordinal++) {
      let end = Math.min(i + 65536, raw.length);
      // SQLite stores UTF-8: never split a UTF-16 surrogate pair across chunks.
      const last = raw.charCodeAt(end - 1);
      if (end < raw.length && last >= 0xD800 && last <= 0xDBFF) end--;
      chunks.push(db.prepare("INSERT INTO source_chunks VALUES(?,?,?)").bind(snapshot.meta.id, ordinal, raw.slice(i, end)));
      i = end;
    }
    await batches(db, chunks);
    await batches(db, snapshot.senses.map(s => db.prepare("INSERT INTO senses VALUES(?,?,?,?,?)").bind(s.id, snapshot.meta.id, s.lemma, s.gloss, s.row)));
    await batches(db, snapshot.examples.map(e => db.prepare("INSERT INTO examples VALUES(?,?,?,?,?,?,?)").bind(e.id, snapshot.meta.id, e.senseId, e.sentence, JSON.stringify(e.grac), e.row, e.index)));
    await db.prepare("UPDATE snapshots SET status='ready' WHERE id=?").bind(snapshot.meta.id).run();
  } catch (error) {
    await db.prepare("DELETE FROM snapshots WHERE id=?").bind(snapshot.meta.id).run();
    throw error;
  }
  return snapshot.meta;
}
export async function loadSnapshot(db: D1Database, id: string): Promise<ParsedSnapshot> {
  const meta = await snapshotMeta(db, id);
  const senses = await all<Sense>(db, "SELECT id,lemma,gloss,row_index AS row FROM senses WHERE snapshot_id=? ORDER BY row_index", id);
  // Sampling only needs identities, not the much larger GRAC metadata.
  const examples = await all<Example>(db, "SELECT id,sense_id AS senseId,row_index AS row,example_index AS 'index' FROM examples WHERE snapshot_id=? ORDER BY row_index,example_index", id);
  return { meta, senses, examples };
}
export async function getProject(db: D1Database, id: string): Promise<Project> {
  const project = await db.prepare(`SELECT ${projectColumns} FROM projects WHERE id=?`).bind(id).first<Project>();
  if (!project) throw new AuditError("Проєкт не знайдено.", 404);
  return project;
}
export async function listProjects(db: D1Database): Promise<ProjectSummary[]> {
  return all(db, `SELECT ${projectColumns},(SELECT COUNT(*) FROM samples WHERE project_id=projects.id AND verdict IS NOT NULL) AS completed,(SELECT COUNT(*) FROM samples WHERE project_id=projects.id AND revealed_at IS NOT NULL) AS revealed FROM projects ORDER BY created_at DESC`);
}
function projectStatements(db: D1Database, p: Project, samples: Sample[]) {
  return [db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)").bind(p.id, p.snapshotId, p.name, p.reviewer, p.seed, p.sampleSize, p.sampler, p.createdAt, p.lastPosition), ...samples.map(s => db.prepare("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(p.id, s.position, s.exampleId, JSON.stringify(s.optionIds), s.blindChoice, s.revealedAt, s.verdict, s.reason, s.replacementSenseId, s.notes, s.updatedAt, s.version))];
}
export async function createProject(db: D1Database, input: { snapshotId: string; name: string; reviewer: string; seed: string; sampleSize: number }) {
  if (typeof input.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(input.snapshotId)) throw new AuditError("Оберіть знімок даних.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200 || typeof input.reviewer !== "string" || !input.reviewer.trim() || input.reviewer.length > 200) throw new AuditError("Вкажіть назву проєкту й ім’я перевіряльника (до 200 символів).");
  const snapshot = await loadSnapshot(db, input.snapshotId);
  const drawn = await drawSample(snapshot, input.sampleSize, input.seed);
  const project: Project = { id: crypto.randomUUID(), snapshotId: input.snapshotId, name: input.name.trim(), reviewer: input.reviewer.trim(), seed: input.seed, sampleSize: input.sampleSize, sampler: SAMPLER, createdAt: new Date().toISOString(), lastPosition: 0 };
  const samples: Sample[] = drawn.map(s => ({ ...s, projectId: project.id, blindChoice: null, revealedAt: null, verdict: null, reason: "", replacementSenseId: null, notes: "", updatedAt: null, version: 0 }));
  // All membership rows and their project are committed atomically.
  await db.batch(projectStatements(db, project, samples));
  return project;
}
export async function projectDetails(db: D1Database, id: string) {
  const project = await getProject(db, id);
  const queue = await all<Omit<QueueItem, "revealed"> & { revealed: number }>(db, "SELECT samples.position,samples.example_id AS exampleId,senses.lemma,samples.verdict,(samples.revealed_at IS NOT NULL) AS revealed FROM samples JOIN examples ON examples.id=samples.example_id JOIN senses ON senses.id=examples.sense_id WHERE samples.project_id=? ORDER BY samples.position", id);
  return { project, snapshot: await snapshotMeta(db, project.snapshotId), queue: queue.map(r => ({ ...r, revealed: Boolean(r.revealed) })) };
}
export async function getSample(db: D1Database, projectId: string, exampleId: string): Promise<Sample> {
  const row = await db.prepare(`SELECT ${sampleColumns} FROM samples WHERE project_id=? AND example_id=?`).bind(projectId, exampleId).first<RawSample>();
  if (!row) throw new AuditError("Приклад не входить до вибірки.", 404);
  return sampleFromRow(row);
}
export async function getReviewItem(db: D1Database, projectId: string, exampleId: string): Promise<ReviewItem> {
  const sample = await getSample(db, projectId, exampleId);
  const example = await db.prepare("SELECT examples.sentence,examples.grac,examples.sense_id AS senseId,senses.lemma FROM examples JOIN senses ON senses.id=examples.sense_id WHERE examples.id=?").bind(exampleId).first<{ sentence: string; grac: string; senseId: string; lemma: string }>();
  if (!example) throw new AuditError("Приклад не знайдено.", 404);
  const options = await all<{ id: string; gloss: string }>(db, `SELECT id,gloss FROM senses WHERE id IN (${sample.optionIds.map(() => "?").join(",")})`, ...sample.optionIds);
  const item: ReviewItem = { projectId, position: sample.position, exampleId, lemma: example.lemma, sentence: example.sentence, options: sample.optionIds.map(id => options.find(s => s.id === id)!), blindChoice: sample.blindChoice, revealedAt: sample.revealedAt, version: sample.version, assessment: sample.verdict ? { verdict: sample.verdict, reason: sample.reason as Assessment["reason"], replacementSenseId: sample.replacementSenseId, notes: sample.notes } : null };
  if (sample.revealedAt) {
    item.assignedSenseId = example.senseId;
    item.grac = JSON.parse(example.grac);
    item.history = await all<History>(db, "SELECT id,project_id AS projectId,example_id AS exampleId,type,data,at FROM history WHERE project_id=? AND example_id=? ORDER BY id", projectId, exampleId);
  }
  return item;
}
function validChoice(choice: unknown, options: string[]) {
  return typeof choice === "string" && (options.includes(choice) || (SPECIAL_CHOICES as readonly string[]).includes(choice));
}
function checkVersion(version: unknown, sample: Sample) {
  if (!Number.isInteger(version) || version !== sample.version) throw new AuditError("Приклад змінено в іншій вкладці. Оновіть сторінку перед збереженням.", 409);
}
export async function reveal(db: D1Database, projectId: string, exampleId: string, choice: unknown, version: unknown) {
  const sample = await getSample(db, projectId, exampleId);
  if (!validChoice(choice, sample.optionIds)) throw new AuditError("Оберіть значення або позначте невизначеність.");
  // A lost response can be retried safely, but the committed judgment is immutable.
  if (sample.revealedAt) {
    if (sample.blindChoice !== choice) throw new AuditError("Початкове судження вже зафіксовано.", 409);
    return getReviewItem(db, projectId, exampleId);
  }
  checkVersion(version, sample);
  const now = new Date().toISOString();
  const updated = await db.prepare("UPDATE samples SET blind_choice=?,revealed_at=?,updated_at=?,version=version+1 WHERE project_id=? AND example_id=? AND version=? RETURNING version").bind(choice, now, now, projectId, exampleId, version).first();
  if (!updated) throw new AuditError("Приклад змінено в іншій вкладці. Оновіть сторінку.", 409);
  await setPosition(db, projectId, sample.position);
  return getReviewItem(db, projectId, exampleId);
}
export function validateAssessment(value: unknown, options: string[], assigned: string): asserts value is Assessment {
  const a = value as Assessment;
  if (!a || !(VERDICTS as readonly unknown[]).includes(a.verdict) || typeof a.notes !== "string" || a.notes.length > 10000 || typeof a.reason !== "string" || (a.reason !== "" && !(REASONS as readonly string[]).includes(a.reason))) throw new AuditError("Некоректний результат перевірки або примітка довша за 10 000 символів.");
  if (a.verdict === "unresolved" && !["insufficient_context", "overlapping_senses", "unclear_target", "other"].includes(a.reason)) throw new AuditError("Для невизначеного випадку оберіть причину.");
  if (a.verdict === "correct" && (a.reason !== "" || a.replacementSenseId !== null)) throw new AuditError("Для правильної мітки не потрібні причина чи виправлення.");
  if (a.verdict !== "incorrect" && a.replacementSenseId !== null) throw new AuditError("Запропонувати інше значення можна для неправильної мітки.");
  if (a.replacementSenseId !== null && (typeof a.replacementSenseId !== "string" || !options.includes(a.replacementSenseId) || a.replacementSenseId === assigned)) throw new AuditError("Запропоноване значення має відрізнятися від автоматичної мітки й належати цій лемі.");
}
export async function saveAssessment(db: D1Database, projectId: string, exampleId: string, value: unknown, version: unknown) {
  const sample = await getSample(db, projectId, exampleId);
  if (!sample.revealedAt) throw new AuditError("Спочатку зафіксуйте початкове судження й відкрийте мітку.", 409);
  checkVersion(version, sample);
  const example = await db.prepare("SELECT sense_id FROM examples WHERE id=?").bind(exampleId).first<{ sense_id: string }>();
  validateAssessment(value, sample.optionIds, example!.sense_id);
  const now = new Date().toISOString();
  const updated = await db.prepare("UPDATE samples SET verdict=?,reason=?,replacement_sense_id=?,notes=?,updated_at=?,version=version+1 WHERE project_id=? AND example_id=? AND version=? RETURNING version").bind(value.verdict, value.reason, value.replacementSenseId, value.notes, now, projectId, exampleId, version).first();
  if (!updated) throw new AuditError("Приклад змінено в іншій вкладці. Оновіть сторінку.", 409);
  await setPosition(db, projectId, sample.position);
  return getReviewItem(db, projectId, exampleId);
}
export async function setPosition(db: D1Database, projectId: string, position: number) {
  const project = await getProject(db, projectId);
  if (!Number.isInteger(position) || position < 0 || position >= project.sampleSize) throw new AuditError("Некоректна позиція у вибірці.");
  await db.prepare("UPDATE projects SET last_position=? WHERE id=?").bind(position, projectId).run();
}
export async function projectResults(db: D1Database, projectId: string) {
  const project = await getProject(db, projectId), snapshot = await snapshotMeta(db, project.snapshotId);
  const rows = await all<{ verdict: string | null; reason: string; lemma: string; senseId: string }>(db, "SELECT samples.verdict,samples.reason,senses.lemma,examples.sense_id AS senseId FROM samples JOIN examples ON examples.id=samples.example_id JOIN senses ON senses.id=examples.sense_id WHERE project_id=?", projectId);
  const counts = { correct: 0, incorrect: 0, unresolved: 0, pending: 0 };
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (!r.verdict) counts.pending++;
    else counts[r.verdict as keyof typeof counts]++;
    if (r.verdict === "unresolved") reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }
  const complete = counts.pending === 0;
  return { project, snapshot, counts, unresolvedReasons: reasons, completed: rows.length - counts.pending, complete, coverage: { lemmas: new Set(rows.map(r => r.lemma)).size, senses: new Set(rows.map(r => r.senseId)).size }, percentages: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / project.sampleSize])), confirmedProportion: complete ? counts.correct / project.sampleSize : null, interval: complete ? finitePopulationInterval(snapshot.population, project.sampleSize, counts.correct) : null, planningMargin: planningMargin(snapshot.population, project.sampleSize) };
}
