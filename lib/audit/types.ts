export const DEFAULT_REVISION = "0e361daf8cfb233e8b5b4cb365d966e4460886a2";
export const REPOSITORY = "yuriilaba/ukrainian_wsd_benchmark";
export const SOURCE_FILE = "huggingface_supported_grac_metadata.jsonl";
export const SAMPLER = "sha256-mulberry32-rejection-fisher-yates-v1";
export const SPECIAL_CHOICES = ["none", "uncertain"] as const;
export const VERDICTS = ["correct", "incorrect", "unresolved"] as const;
export const REASONS = ["insufficient_context", "overlapping_senses", "unclear_target", "no_matching_definition", "other"] as const;
export type Verdict = typeof VERDICTS[number];
export type Reason = typeof REASONS[number];
export type Sense = { id: string; lemma: string; gloss: string; row: number };
export type Example = { id: string; senseId: string; sentence: string; grac: Record<string, unknown>; row: number; index: number };
export type SnapshotMeta = { id: string; checksum: string; repository: string; revision: string | null; filename: string; importedAt: string; population: number; senses: number; lemmas: number; bytes: number };
export type ParsedSnapshot = { meta: SnapshotMeta; senses: Sense[]; examples: Example[] };
export type Project = { id: string; snapshotId: string; name: string; reviewer: string; seed: string; sampleSize: number; sampler: string; createdAt: string; lastPosition: number };
export type Assessment = { verdict: Verdict; reason: Reason | ""; replacementSenseId: string | null; notes: string };
export type Sample = { projectId: string; position: number; exampleId: string; optionIds: string[]; blindChoice: string | null; revealedAt: string | null; verdict: Verdict | null; reason: string; replacementSenseId: string | null; notes: string; updatedAt: string | null; version: number };
export type History = { id: number; projectId: string; exampleId: string; type: "reveal" | "assessment"; data: string; at: string };
export type QueueItem = { position: number; exampleId: string; lemma: string; verdict: Verdict | null; revealed: boolean };
export type ProjectSummary = Project & { completed: number; revealed: number };
export type ReviewItem = { projectId: string; position: number; exampleId: string; lemma: string; sentence: string; options: { id: string; gloss: string }[]; blindChoice: string | null; revealedAt: string | null; version: number; assessment: Assessment | null; assignedSenseId?: string; grac?: Record<string, unknown>; history?: History[] };
export class AuditError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "AuditError"; this.status = status; }
}
