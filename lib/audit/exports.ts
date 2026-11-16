import { AuditError, SAMPLER } from "./types.ts";
import type { Assessment, History, Project, Sample, SnapshotMeta } from "./types.ts";
import { drawSample, parseSnapshot } from "./dataset.ts";
import { getProject, importSnapshot, projectResults, snapshotMeta, snapshotRaw, validateAssessment } from "./store.ts";

export const verdictLabels = { correct: "Правильна мітка", incorrect: "Неправильна мітка", unresolved: "Неоднозначно / недостатньо контексту", pending: "Не завершено" };
export const reasonLabels: Record<string, string> = { insufficient_context: "Недостатньо контексту", overlapping_senses: "Значення перетинаються", unclear_target: "Незрозуміле цільове вживання", no_matching_definition: "Жодне визначення не підходить", other: "Інша причина" };
function pct(x: number) { return (x * 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
export async function reportMarkdown(db: D1Database, id: string) {
  const r = await projectResults(db, id);
  if (!r.complete || !r.interval || r.confirmedProportion === null) throw new AuditError("Фінальний звіт доступний після завершення всієї вибірки.", 409);
  const paragraph = `Для оцінювання якості автоматично сформованих анотацій автор (${r.project.reviewer}) вручну перевірив просту випадкову вибірку без повернення з ${r.project.sampleSize} контекстуальних прикладів із ${r.snapshot.population}. Для кожного прикладу спочатку, без показу автоматичної мітки, обирали значення серед усіх визначень відповідної леми, збережених у цій версії бенчмарку. Після відкриття мітки оцінювали відповідність цільового вживання призначеному значенню та достатність контексту для однозначної інтерпретації. Підтверджено ${r.counts.correct} міток (${pct(r.confirmedProportion)}; 95% довірчий інтервал — ${pct(r.interval.lower)}–${pct(r.interval.upper)}), неправильними визнано ${r.counts.incorrect}, невизначеними — ${r.counts.unresolved}. Невизначені випадки залишено в знаменнику частки підтверджених відповідностей. Інтервал обчислено шляхом інверсії двобічних рівнохвостих гіпергеометричних тестів для скінченної сукупності.`;
  const markdown = `# Вибіркова авторська валідація WSD\n\n${paragraph}\n\n## Результати\n\n| Результат | Кількість | Частка вибірки |\n|---|---:|---:|\n${(["correct", "incorrect", "unresolved"] as const).map(v => `| ${verdictLabels[v]} | ${r.counts[v]} | ${pct(r.percentages[v])} |`).join("\n")}\n\n## Відтворюваність\n\n- Проєкт: ${r.project.name}\n- Перевіряльник: ${r.project.reviewer}\n- Джерело: https://huggingface.co/datasets/${r.snapshot.repository}\n- Ревізія: ${r.snapshot.revision ?? "локальний імпорт; ідентифікація за SHA-256"}\n- SHA-256: ${r.snapshot.checksum}\n- Seed: ${r.project.seed}\n- Алгоритм відбору: ${r.project.sampler}\n- Охоплено лем: ${r.coverage.lemmas}; значень: ${r.coverage.senses}\n- Метод інтервалу: ${r.interval.method}\n- Планова консервативна похибка (p=0,5): ±${(r.planningMargin * 100).toLocaleString("uk-UA", { maximumFractionDigits: 2 })} в. п.\n\n## Причини невизначеності\n\n${Object.entries(r.unresolvedReasons).map(([k, v]) => `- ${reasonLabels[k] ?? k}: ${v}`).join("\n") || "Невизначених випадків немає."}\n\n## Межі висновків\n\nПеревірка є авторською; незалежну експертну валідацію та міжанотаторну узгодженість не оцінювали. Оцінка стосується збережених у бенчмарку відповідностей і суджень цього перевіряльника. Вона не підтверджує якість кожного значення окремо та не оцінює повноту автоматичного добору контекстів. Показано лише визначення, збережені у бенчмарку, а не повний словник. Додатковий контекст автоматично не отримували. Невизначені випадки не прирівнюють до доведених помилок.\n\nГіпергеометрична модель вибірки без повернення: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.hypergeom.html\n`;
  return { paragraph, markdown };
}
export async function exportBackup(db: D1Database, id: string) {
  const project = await getProject(db, id), meta = await snapshotMeta(db, project.snapshotId);
  const samples = (await db.prepare("SELECT project_id AS projectId,position,example_id AS exampleId,option_ids AS optionIds,blind_choice AS blindChoice,revealed_at AS revealedAt,verdict,reason,replacement_sense_id AS replacementSenseId,notes,updated_at AS updatedAt,version FROM samples WHERE project_id=? ORDER BY position").bind(id).all<Omit<Sample, "optionIds"> & { optionIds: string }>()).results.map(s => ({ ...s, optionIds: JSON.parse(s.optionIds) }));
  const history = (await db.prepare("SELECT id,project_id AS projectId,example_id AS exampleId,type,data,at FROM history WHERE project_id=? ORDER BY id").bind(id).all<History>()).results;
  return { format: "ukrainian-wsd-audit", version: 1, exportedAt: new Date().toISOString(), source: { meta, raw: await snapshotRaw(db, project.snapshotId) }, project, samples, history };
}
function requireBackup(condition: unknown, detail = "структура"): asserts condition {
  if (!condition) throw new AuditError(`Некоректна резервна копія: ${detail}.`);
}
function validDate(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export async function restoreBackup(db: D1Database, input: unknown) {
  const b = input as ReturnType<typeof exportBackup> extends Promise<infer T> ? T : never;
  requireBackup(b && b.format === "ukrainian-wsd-audit" && b.version === 1 && b.source && typeof b.source.raw === "string" && b.source.meta && b.project && Array.isArray(b.samples) && Array.isArray(b.history));
  requireBackup(b.source.meta.revision === null || typeof b.source.meta.revision === "string" && /^[a-f0-9]{40}$/.test(b.source.meta.revision), "ревізія джерела");
  const parsed = await parseSnapshot(b.source.raw, b.source.meta.revision);
  const p = b.project;
  requireBackup(parsed.meta.checksum === b.source.meta.checksum && p.snapshotId === parsed.meta.id && b.source.meta.population === parsed.meta.population && b.source.meta.senses === parsed.meta.senses && b.source.meta.lemmas === parsed.meta.lemmas, "контрольна сума або кількість записів");
  requireBackup(p.sampler === SAMPLER && typeof p.id === "string" && typeof p.name === "string" && p.name.trim() && p.name.length <= 200 && typeof p.reviewer === "string" && p.reviewer.trim() && p.reviewer.length <= 200 && validDate(p.createdAt) && Number.isInteger(p.lastPosition) && p.lastPosition >= 0 && p.lastPosition < p.sampleSize, "властивості проєкту");
  const expected = await drawSample(parsed, p.sampleSize, p.seed);
  requireBackup(b.samples.length === expected.length, "обсяг вибірки");
  const examples = new Map(parsed.examples.map(e => [e.id, e]));
  const sampleIds = new Set<string>();
  for (let i = 0; i < expected.length; i++) {
    const s = b.samples[i], e = expected[i];
    requireBackup(s && s.projectId === p.id && s.position === i && s.exampleId === e.exampleId && JSON.stringify(s.optionIds) === JSON.stringify(e.optionIds), "вибірка не відповідає seed");
    sampleIds.add(s.exampleId);
    requireBackup(Number.isInteger(s.version) && s.version >= 0, "версія запису");
    requireBackup(s.blindChoice === null || typeof s.blindChoice === "string" && [...s.optionIds, "none", "uncertain"].includes(s.blindChoice), "початкове судження");
    requireBackup((s.blindChoice === null && s.revealedAt === null && s.verdict === null && s.version === 0 && s.updatedAt === null && s.notes === "" && s.reason === "" && s.replacementSenseId === null) || (s.blindChoice !== null && validDate(s.revealedAt) && s.version >= 1 && validDate(s.updatedAt)), "стан відкриття мітки");
    if (s.verdict !== null) validateAssessment(s as Assessment, s.optionIds, examples.get(s.exampleId)!.senseId);
    else requireBackup(s.notes === "" && s.reason === "" && s.replacementSenseId === null && s.version <= 1, "незавершена оцінка");
  }
  const byExample = new Map<string, History[]>();
  for (const h of b.history) {
    requireBackup(h && h.projectId === p.id && sampleIds.has(h.exampleId) && ["reveal", "assessment"].includes(h.type) && typeof h.data === "string" && validDate(h.at), "журнал змін");
    byExample.set(h.exampleId, [...(byExample.get(h.exampleId) ?? []), h]);
  }
  for (const s of b.samples) {
    const entries = byExample.get(s.exampleId) ?? [];
    requireBackup(entries.length === s.version, "неповний журнал змін");
    for (let i = 0; i < entries.length; i++) {
      let d;
      try { d = JSON.parse(entries[i].data); } catch { throw new AuditError("Некоректна резервна копія: JSON журналу."); }
      requireBackup(d && d.version === i + 1 && d.blindChoice === s.blindChoice && d.revealedAt === s.revealedAt && entries[i].type === (i === 0 ? "reveal" : "assessment"), "послідовність журналу");
      if (i === 0) requireBackup(d.verdict === null && d.reason === "" && d.notes === "" && d.replacementSenseId === null, "початковий запис журналу");
      else validateAssessment(d, s.optionIds, examples.get(s.exampleId)!.senseId);
      if (i === entries.length - 1) requireBackup(d.verdict === s.verdict && d.reason === s.reason && d.notes === s.notes && d.replacementSenseId === s.replacementSenseId && entries[i].at === s.updatedAt, "останній стан журналу");
    }
  }
  // Validate the entire backup before any write. Restore creates a new project,
  // keeping the original and its audit history intact.
  const meta = await importSnapshot(db, b.source.raw, b.source.meta.revision, parsed);
  const id = crypto.randomUUID();
  const project: Project = { ...p, id, snapshotId: meta.id };
  const statements = [db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)").bind(id, project.snapshotId, project.name, project.reviewer, project.seed, project.sampleSize, project.sampler, project.createdAt, project.lastPosition), ...b.samples.map(s => db.prepare("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, s.position, s.exampleId, JSON.stringify(s.optionIds), s.blindChoice, s.revealedAt, s.verdict, s.reason, s.replacementSenseId, s.notes, s.updatedAt, s.version)), ...b.history.map(h => db.prepare("INSERT INTO history(project_id,example_id,type,data,at) VALUES(?,?,?,?,?)").bind(id, h.exampleId, h.type, h.data, h.at))];
  await db.batch(statements);
  return project;
}

function csvCell(value: unknown) {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Keep spreadsheets from interpreting arbitrary corpus text as formulas.
  if (/^[\s]*[=+@-]/u.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportCsv(db: D1Database, id: string) {
  const p = await getProject(db, id), meta = await snapshotMeta(db, p.snapshotId);
  const rows = (await db.prepare("SELECT samples.*,examples.sentence,examples.grac,examples.row_index,examples.example_index,senses.lemma,senses.gloss,senses.id AS assigned_id FROM samples JOIN examples ON examples.id=samples.example_id JOIN senses ON senses.id=examples.sense_id WHERE samples.project_id=? ORDER BY samples.position").bind(id).all<Record<string, unknown>>()).results;
  const glosses = new Map((await db.prepare("SELECT id,gloss FROM senses WHERE snapshot_id=?").bind(p.snapshotId).all<{ id: string; gloss: string }>()).results.map(s => [s.id, s.gloss]));
  const header = ["project_id", "reviewer", "snapshot_sha256", "revision", "seed", "sampling_algorithm", "position", "example_id", "lemma", "sentence", "blind_choice", "blind_gloss", "revealed_at", "assigned_sense_id", "assigned_gloss", "verdict", "reason", "replacement_sense_id", "replacement_gloss", "notes", "updated_at", "version", "source_row", "source_example_index", "grac"];
  const lines = rows.map(r => [id, p.reviewer, meta.checksum, meta.revision, p.seed, p.sampler, Number(r.position) + 1, r.example_id, r.lemma, r.sentence, r.blind_choice, glosses.get(String(r.blind_choice)) ?? "", r.revealed_at, r.revealed_at ? r.assigned_id : "", r.revealed_at ? r.gloss : "", r.verdict, r.reason, r.replacement_sense_id, glosses.get(String(r.replacement_sense_id)) ?? "", r.notes, r.updated_at, r.version, r.revealed_at ? r.row_index : "", r.revealed_at ? r.example_index : "", r.revealed_at ? r.grac : ""].map(csvCell).join(","));
  return "\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n");
}
