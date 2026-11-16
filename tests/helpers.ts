import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

// A real SQLite engine with the D1 interface used by the service. Tests exercise
// transactions, constraints, triggers and persistence, rather than mocking SQL.
export class LocalSqlite {
  sqlite: DatabaseSync;
  failNextWrite = false;
  constructor(path = ":memory:") { this.sqlite = new DatabaseSync(path); this.sqlite.exec("PRAGMA foreign_keys=ON"); }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const result = []; for (const s of statements) result.push(await s.all()); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
  close() { this.sqlite.close(); }
}
class Statement {
  owner: LocalSqlite;
  sql: string;
  params: SQLInputValue[] = [];
  constructor(owner: LocalSqlite, sql: string) { this.owner = owner; this.sql = sql; }
  bind(...params: SQLInputValue[]) { this.params = params; return this; }
  execute() {
    if (this.owner.failNextWrite && /^(INSERT|UPDATE|DELETE)/.test(this.sql)) { this.owner.failNextWrite = false; throw new Error("Simulated disk write failure"); }
    return this.owner.sqlite.prepare(this.sql);
  }
  async run() {
    const result = this.execute().run(...this.params);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
  async all() { return { success: true, results: this.execute().all(...this.params), meta: {} }; }
  async first(column?: string) { const row = this.execute().get(...this.params); return row ? column ? row[column] : row : null; }
}

export const fixtureRaw = [
  { lemma: "замок", gloss: ["пристрій для замикання дверей"], examples: [{ sentence: "Майстер полагодив замок.", grac: { document_id: "d1", sentence_id: "s1", document_title: "Оповідання", publication_year: "2025" } }, { sentence: "Ключ застряг у замку.", grac: { document_id: "d1", sentence_id: "s2" } }, { sentence: "Вона придбала новий замок.", grac: {} }] },
  { lemma: "замок", gloss: ["укріплена будівля"], examples: [{ sentence: "Старий замок височів над містом.", grac: { document_id: "d2", sentence_id: "s3" } }, { sentence: "Вони відвідали замок.", grac: {} }, { sentence: "Ми побачили замок.", grac: {} }] },
  { lemma: "коса", gloss: ["заплетене волосся"], examples: [{ sentence: "Дівчина заплела косу.", grac: {} }, { sentence: "Довга коса спадала на плече.", grac: {} }] },
  { lemma: "коса", gloss: ["знаряддя для косіння"], examples: [{ sentence: "Селянин нагострив косу.", grac: {} }, { sentence: "Коса лежить у сараї.", grac: {} }] },
].map(row => JSON.stringify(row)).join("\n") + "\n";
