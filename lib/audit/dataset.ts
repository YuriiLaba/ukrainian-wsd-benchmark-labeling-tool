import { AuditError, REPOSITORY, SAMPLER, SOURCE_FILE } from "./types.ts";
import type { ParsedSnapshot } from "./types.ts";

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function parseSnapshot(raw: string, revision: string | null = null): Promise<ParsedSnapshot> {
  if (!raw.trim()) throw new AuditError("Файл порожній.");
  if (new TextEncoder().encode(raw).length > 80 * 1024 * 1024) throw new AuditError("Максимальний розмір файлу — 80 МБ.");
  const checksum = await sha256(raw);
  const senses: ParsedSnapshot["senses"] = [];
  const examples: ParsedSnapshot["examples"] = [];
  let lineNumber = 0;
  for (const line of raw.split("\n")) {
    lineNumber++;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new AuditError(`Некоректний JSON у рядку ${lineNumber}.`); }
    if (!row || typeof row.lemma !== "string" || !row.lemma.trim() || !Array.isArray(row.gloss) || row.gloss.length !== 1 || typeof row.gloss[0] !== "string" || !row.gloss[0].trim() || !Array.isArray(row.examples) || row.examples.length === 0) {
      throw new AuditError(`Рядок ${lineNumber}: потрібні lemma, одне визначення gloss та непорожній examples.`);
    }
    const rowIndex = senses.length;
    const senseId = await sha256(`${checksum}:sense:${rowIndex}`);
    senses.push({ id: senseId, lemma: row.lemma, gloss: row.gloss[0], row: rowIndex });
    for (let index = 0; index < row.examples.length; index++) {
      const e = row.examples[index];
      if (!e || typeof e.sentence !== "string" || !e.sentence.trim() || (e.grac != null && (typeof e.grac !== "object" || Array.isArray(e.grac)))) throw new AuditError(`Рядок ${lineNumber}, приклад ${index + 1}: некоректне речення або метадані GRAC.`);
      examples.push({ id: await sha256(`${checksum}:example:${rowIndex}:${index}`), senseId, sentence: e.sentence, grac: e.grac ?? {}, row: rowIndex, index });
    }
  }
  if (!examples.length) throw new AuditError("Файл не містить прикладів.");
  return { meta: { id: checksum, checksum, repository: REPOSITORY, revision, filename: SOURCE_FILE, importedAt: new Date().toISOString(), population: examples.length, senses: senses.length, lemmas: new Set(senses.map(s => s.lemma)).size, bytes: new TextEncoder().encode(raw).length }, senses, examples };
}

// The seed is a UTF-8 string, hashed to a fixed 32-bit state. Rejection sampling
// avoids the modulo bias when mapping 32-bit PRNG output to shuffle indices.
export async function shuffled<T>(values: T[], seed: string): Promise<T[]> {
  let state = parseInt((await sha256(seed)).slice(0, 8), 16) >>> 0;
  function nextUint32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = Math.floor(0x100000000 / bound) * bound;
    let random;
    do { random = nextUint32(); } while (random >= limit);
    const j = random % bound;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function drawSample(snapshot: ParsedSnapshot, size: number, seed: string) {
  if (!Number.isInteger(size) || size < 1 || size > snapshot.examples.length) throw new AuditError(`Обсяг вибірки має бути від 1 до ${snapshot.examples.length}.`);
  if (typeof seed !== "string" || !seed.trim() || seed.length > 200) throw new AuditError("Задайте seed (до 200 символів).");
  const selected = (await shuffled(snapshot.examples, `${SAMPLER}:sample:${seed}`)).slice(0, size);
  const byLemma = new Map<string, string[]>();
  const bySense = new Map(snapshot.senses.map(s => [s.id, s]));
  for (const sense of snapshot.senses) byLemma.set(sense.lemma, [...(byLemma.get(sense.lemma) ?? []), sense.id]);
  return Promise.all(selected.map(async (example, position) => ({ exampleId: example.id, position, optionIds: await shuffled(byLemma.get(bySense.get(example.senseId)!.lemma)!, `${SAMPLER}:options:${seed}:${example.id}`) })));
}
