"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, Database, Eye, FileText, FolderOpen, HardDrive, History as HistoryIcon, LockKeyhole, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Upload, X } from "lucide-react";
import { DEFAULT_REVISION, REPOSITORY } from "../lib/audit/types";
import type { Assessment, Project, ProjectSummary, QueueItem, ReviewItem, SnapshotMeta, Verdict } from "../lib/audit/types";
import type { projectDetails, projectResults } from "../lib/audit/store";
import { planningMargin } from "../lib/audit/statistics";
// Labels are deliberately client-local; no database or assigned-label code is
// bundled into the review interface.
const VERDICTS = { correct: "Правильна", incorrect: "Неправильна", unresolved: "Невизначено" };
const REASONS: Record<string, string> = { insufficient_context: "Недостатньо контексту", overlapping_senses: "Значення перетинаються", unclear_target: "Незрозуміле цільове вживання", no_matching_definition: "Жодне визначення не підходить", other: "Інша причина" };
type Details = Awaited<ReturnType<typeof projectDetails>>;
type Results = Awaited<ReturnType<typeof projectResults>>;
type Page = "review" | "results";
function percent(n: number, digits = 1) { return (n * 100).toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%"; }
function count(n: number) { return n.toLocaleString("uk-UA"); }
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}
function navigate(id?: string, page: Page = "review") { window.location.hash = id ? `project/${id}/${page}` : ""; }
function readRoute(): { id: string | null; page: Page } {
  const parts = window.location.hash.slice(1).split("/");
  return { id: parts[0] === "project" && parts[1] ? parts[1] : null, page: parts[2] === "results" ? "results" : "review" };
}
function Progress({ done, total }: { done: number; total: number }) {
  return <div className="progress" role="progressbar" aria-label="Завершено перевірок" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><span style={{ width: `${done / total * 100}%` }} /></div>;
}

export default function AuditApp() {
  const [route, setRoute] = useState<{ id: string | null; page: Page }>({ id: null, page: "review" });
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [details, setDetails] = useState<Details | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [position, setPosition] = useState(0);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const restoreRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const refreshLists = useCallback(async () => {
    const [s, p] = await Promise.all([api<SnapshotMeta[]>("snapshots"), api<ProjectSummary[]>("projects")]);
    // A removed project must not leave human judgments in browser drafts.
    try {
      const projectIds = new Set(p.map(project => project.id));
      const draftKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      for (const key of draftKeys) {
        if (key?.startsWith("wsd:draft:") && !projectIds.has(key.split(":")[2])) localStorage.removeItem(key);
      }
    } catch { /* Browser storage may be unavailable; saved reviews live in SQLite. */ }
    setSnapshots(s); setProjects(p);
  }, []);
  useEffect(() => {
    const update = () => { setRoute(readRoute()); setError(""); };
    update(); window.addEventListener("hashchange", update);
    refreshLists().catch(e => setError(e.message)).finally(() => setLoading(false));
    return () => window.removeEventListener("hashchange", update);
  }, [refreshLists]);
  useEffect(() => {
    setDetails(null); setItem(null); setResults(null); setFilter("all"); setSearch("");
    if (!route.id) { refreshLists().catch(e => setError(e.message)); return; }
    const controller = new AbortController();
    Promise.all([api<Details>(`projects/${route.id}`, undefined, controller.signal), api<Results>(`projects/${route.id}/results`, undefined, controller.signal)]).then(([d, r]) => {
      setDetails(d); setResults(r); setPosition(d.project.lastPosition);
    }).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [route.id, refreshLists]);
  const selectedId = details?.queue[position]?.exampleId;
  useEffect(() => {
    setItem(null);
    if (!route.id || !selectedId) return;
    const controller = new AbortController();
    api<ReviewItem>(`projects/${route.id}/items/${selectedId}`, undefined, controller.signal).then(setItem).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [route.id, selectedId]);
  async function run<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await task(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не вдалося виконати дію."); }
    finally { setBusy(""); }
  }
  async function refreshProject(id: string) {
    const [d, r] = await Promise.all([api<Details>(`projects/${id}`), api<Results>(`projects/${id}/results`)]);
    setDetails(d); setResults(r);
    return d;
  }
  async function revealItem(choice: string) {
    if (!item) return;
    const current = item;
    await run("Зберігаємо початкове судження…", async () => {
      const updated = await api<ReviewItem>(`projects/${current.projectId}/items/${current.exampleId}/reveal`, { choice, version: current.version });
      setItem(updated); await refreshProject(current.projectId);
    });
  }
  async function saveItem(assessment: Assessment, next: boolean) {
    if (!item) return;
    const current = item;
    await run("Зберігаємо оцінку…", async () => {
      const updated = await api<ReviewItem>(`projects/${current.projectId}/items/${current.exampleId}/assessment`, { assessment, version: current.version });
      try { localStorage.removeItem(`wsd:draft:${current.projectId}:${current.exampleId}`); } catch { /* disk state is authoritative */ }
      setItem(updated);
      const d = await refreshProject(current.projectId);
      if (next) {
        const pending = d.queue.find(q => q.position > current.position && !q.verdict) ?? d.queue.find(q => !q.verdict);
        if (pending) selectPosition(pending.position);
        else navigate(current.projectId, "results");
      }
    });
  }
  function selectPosition(next: number) {
    if (!details || next < 0 || next >= details.queue.length || busy) return;
    setPosition(next); setError("");
    const id = ++requestId.current;
    api(`projects/${details.project.id}/position`, { position: next }).catch(e => { if (requestId.current === id) setError(e.message); });
  }
  const done = results?.completed ?? 0;
  const queue = details?.queue.filter(q => (filter === "all" || filter === "pending" && !q.verdict || q.verdict === filter) && q.lemma.toLocaleLowerCase("uk").includes(search.toLocaleLowerCase("uk"))) ?? [];
  async function restore(file?: File) {
    if (!file) return;
    await run("Перевіряємо резервну копію та відновлюємо проєкт…", async () => {
      const p = await api<Project>("restore", JSON.parse(await file.text()));
      await refreshLists(); navigate(p.id);
    });
    if (restoreRef.current) restoreRef.current.value = "";
  }
  return <div className="app-shell">
    <header className="app-header">
      <button className="brand" onClick={() => navigate()} aria-label="Сенс — усі проєкти"><span className="brand-mark"><BookOpen size={23} strokeWidth={1.7} /></span><span>сенс<span className="brand-dot">.</span></span><span className="brand-sub">ЛАБОРАТОРІЯ МОВИ</span></button>
      <nav aria-label="Головна навігація"><button className={!route.id ? "nav-active" : ""} onClick={() => navigate()}><FolderOpen size={16} /> Проєкти</button>{route.id && <><button className={route.page === "review" ? "nav-active" : ""} onClick={() => navigate(route.id!, "review")}><BookOpen size={16} /> Перевірка</button><button className={route.page === "results" ? "nav-active" : ""} onClick={() => navigate(route.id!, "results")}><FileText size={16} /> Результати</button></>}</nav>
      <span className="local-badge"><span className="status-dot" /> Локально на вашому комп’ютері</span>
    </header>
    <input ref={restoreRef} type="file" className="sr-only" accept=".json,application/json" aria-label="Відновити резервну копію" onChange={e => restore(e.target.files?.[0])} />
    {error && <div role="alert" className="error-banner"><CircleHelp size={19} /><span>{error}</span><button aria-label="Закрити повідомлення" onClick={() => setError("")}><X size={18} /></button></div>}
    {busy && <div className="busy-banner" role="status"><span className="spinner" />{busy}</div>}
    {!route.id ? <Home snapshots={snapshots} projects={projects} loading={loading} busy={!!busy} onRestore={() => restoreRef.current?.click()} onImport={(raw, revision) => run("Імпортуємо й перевіряємо знімок даних. Це може тривати кілька хвилин…", async () => {
      const s = revision ? await api<SnapshotMeta>("snapshots/download", { revision }) : await api<SnapshotMeta>("snapshots", { raw });
      await refreshLists(); return s;
    })} onCreate={input => run("Фіксуємо випадкову вибірку…", async () => { const p = await api<Project>("projects", input); await refreshLists(); navigate(p.id); })} /> : !details || !results ? <div className="loading-state"><span className="spinner" />Завантажуємо проєкт…</div> : <>
      <div className="project-heading"><div><div className="eyebrow">АВТОРСЬКА ВАЛІДАЦІЯ <ChevronRight size={12} /> {details.project.reviewer}</div><h1>{details.project.name}</h1></div><div className="project-actions"><span className="project-progress"><strong>{done}</strong> / {details.project.sampleSize} перевірено</span><a className="button secondary small" href={`/api/projects/${route.id}/export?format=backup`}><ArrowDownToLine size={15} />Резервна копія</a></div></div>
      {route.page === "results" ? <ResultsPanel results={results} onContinue={() => { const p = details.queue.find(q => !q.verdict); if (p) selectPosition(p.position); navigate(route.id!, "review"); }} /> : <div className="review-layout">
        <aside className="queue-panel"><div className="queue-top"><h2>Ваша вибірка</h2><span className="pill">{details.project.sampleSize}</span></div><Progress done={done} total={details.project.sampleSize} /><div className="queue-caption">{details.project.sampleSize - done} залишилося · seed {details.project.seed}</div><label className="search-field"><Search size={16} /><input aria-label="Пошук леми" placeholder="Знайти лему…" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="Фільтр результатів" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Усі приклади</option><option value="pending">Не завершено</option><option value="correct">Правильні</option><option value="incorrect">Неправильні</option><option value="unresolved">Невизначені</option></select><div className="queue-list">{queue.map(q => <QueueButton key={q.exampleId} item={q} selected={q.position === position} disabled={!!busy} onClick={() => selectPosition(q.position)} />)}{!queue.length && <p className="muted empty-small">Немає прикладів за цим фільтром.</p>}</div><div className="queue-footer"><ShieldCheck size={16} /><span>Вибірку зафіксовано.<br />Пропущені приклади залишаються.</span></div></aside>
        <main className="review-main">{!item ? <div className="loading-state"><span className="spinner" />Завантажуємо приклад…</div> : <ReviewPane key={`${item.exampleId}:${item.version}`} item={item} total={details.project.sampleSize} busy={!!busy} onReveal={revealItem} onSave={saveItem} onPrevious={() => selectPosition(position - 1)} onNext={() => selectPosition(position + 1)} />}</main>
      </div>}
    </>}
    <footer className="app-footer"><span>Сенс · Ukrainian WSD Benchmark</span><span><HardDrive size={13} /> Прогрес зберігається в локальній базі</span><a href={`https://huggingface.co/datasets/${REPOSITORY}`} target="_blank" rel="noreferrer">Джерело даних ↗</a></footer>
  </div>;
}

type HomeProps = { snapshots: SnapshotMeta[]; projects: ProjectSummary[]; loading: boolean; busy: boolean; onRestore: () => void; onImport: (raw: string | null, revision?: string) => Promise<SnapshotMeta | undefined>; onCreate: (input: { snapshotId: string; name: string; reviewer: string; sampleSize: number; seed: string }) => Promise<unknown> };
function Home({ snapshots, projects, loading, busy, onRestore, onImport, onCreate }: HomeProps) {
  const [snapshotId, setSnapshotId] = useState("");
  const [name, setName] = useState("Авторська валідація WSD");
  const [reviewer, setReviewer] = useState("");
  const [sampleSize, setSampleSize] = useState(400);
  const [seed, setSeed] = useState("42");
  const [revision, setRevision] = useState(DEFAULT_REVISION);
  const [fileError, setFileError] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const selected = snapshots.find(s => s.id === snapshotId) ?? snapshots[0];
  async function upload(file?: File) {
    if (!file) return;
    setFileError("");
    try { const s = await onImport(await file.text()); if (s) setSnapshotId(s.id); }
    catch { setFileError("Не вдалося прочитати файл."); }
    if (uploadRef.current) uploadRef.current.value = "";
  }
  return <main className="home-main">
    <div className="hero"><div><div className="eyebrow"><span className="tiny-line" /> УКРАЇНСЬКИЙ WSD БЕНЧМАРК</div><h1>Від автоматичної мітки<br />до <em>перевіреного значення.</em></h1><p>Уважна ручна перевірка, відтворювана вибірка<br className="desktop-br" /> та результати, готові для вашого дослідження.</p></div><div className="hero-seal"><ShieldCheck size={32} strokeWidth={1.3} /><span>ВАШЕ СУДЖЕННЯ.<br /><strong>НАДІЙНІШІ ДАНІ.</strong></span></div></div>
    <div className="home-grid">
      <section className="setup-card"><div className="card-title"><span className="icon-box"><Plus size={20} /></span><div><h2>Нова перевірка</h2><p>Один проєкт — одна зафіксована вибірка</p></div><span className="step-label">01 / ПОЧАТОК</span></div>
        <div className="source-block"><div className="source-heading"><Database size={18} /><strong>Джерело даних</strong>{!!snapshots.length && <span className="ready-label"><Check size={13} />Готово</span>}</div><p className="source-name">yuriilaba / ukrainian_wsd_benchmark</p>
          {loading ? <p className="muted">Перевіряємо локальні знімки…</p> : selected ? <><label className="sr-only" htmlFor="snapshot">Версія даних</label><select id="snapshot" value={selected.id} onChange={e => setSnapshotId(e.target.value)}>{snapshots.map(s => <option value={s.id} key={s.id}>{count(s.population)} прикладів · {s.checksum.slice(0, 12)}</option>)}</select><div className="source-stats"><span><strong>{count(selected.population)}</strong> прикладів</span><span><strong>{count(selected.senses)}</strong> значень</span><span><strong>{count(selected.lemmas)}</strong> лем</span></div></> : <><p className="muted">Завантажте зафіксовану версію бенчмарку, щоб почати.</p><button type="button" className="button secondary" disabled={busy} onClick={async () => { const s = await onImport(null, revision); if (s) setSnapshotId(s.id); }}><ArrowDownToLine size={16} />Завантажити з Hugging Face</button></>}
          <details className="advanced"><summary>Версія та локальний імпорт</summary><label>Commit SHA Hugging Face<input value={revision} onChange={e => setRevision(e.target.value)} maxLength={40} spellCheck={false} /></label>{!!selected && <button type="button" className="text-button" disabled={busy} onClick={async () => { const s = await onImport(null, revision); if (s) setSnapshotId(s.id); }}>Завантажити цю версію</button>}<button type="button" className="text-button" disabled={busy} onClick={() => uploadRef.current?.click()}><Upload size={14} />Імпортувати JSONL з комп’ютера</button><input ref={uploadRef} type="file" className="sr-only" accept=".jsonl,.ndjson,.json" aria-label="Імпортувати JSONL" onChange={e => upload(e.target.files?.[0])} />{selected && <p className="checksum">SHA-256: {selected.checksum}</p>}{fileError && <p role="alert">{fileError}</p>}</details>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (selected) onCreate({ snapshotId: selected.id, name, reviewer, sampleSize, seed }); }}><div className="form-grid"><label>Назва проєкту<input required value={name} maxLength={200} onChange={e => setName(e.target.value)} /></label><label>Перевіряльник<input required placeholder="Ваше ім’я" maxLength={200} value={reviewer} onChange={e => setReviewer(e.target.value)} /></label></div><div className="sample-config"><div><label htmlFor="sample-size">Обсяг вибірки</label><div className="size-input"><input id="sample-size" type="number" required min={1} max={selected?.population ?? 100000} value={sampleSize} onChange={e => setSampleSize(Number(e.target.value))} /><span>прикладів</span></div></div><label className="seed-label">Випадковий seed<input required maxLength={200} value={seed} onChange={e => setSeed(e.target.value)} spellCheck={false} /></label></div><div className="sample-note"><Sparkles size={15} /><span>{selected && sampleSize > 0 && sampleSize <= selected.population ? <>Планова похибка <strong>±{(planningMargin(selected.population, sampleSize) * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " в. п."}</strong> за 95% довірчого рівня, p=0,5.</> : "400 прикладів — орієнтовна похибка ±4,8 в. п. при 95% довірчому рівні."}</span></div><button className="button primary create-button" type="submit" disabled={busy || !selected || !reviewer.trim() || !name.trim()}><span>Створити вибірку та почати</span><ArrowRight size={18} /></button><p className="form-footnote"><LockKeyhole size={12} />Версію, seed і склад вибірки буде зафіксовано</p></form>
      </section>
      <aside className="home-aside"><section className="workflow-card"><div className="eyebrow">ЯК ПРОХОДИТЬ ПЕРЕВІРКА</div><h2>Спочатку — ваш погляд.</h2><p className="muted">Автоматична мітка відкривається лише після вашого першого рішення.</p><ol className="workflow-list"><li><span>1</span><div><strong>Прочитайте й оберіть</strong><p>Речення, цільова лема та всі збережені визначення. Мітку приховано.</p></div></li><li><span>2</span><div><strong>Порівняйте з міткою</strong><p>Відкрийте автоматичне значення й зафіксуйте підсумкову оцінку.</p></div></li><li><span>3</span><div><strong>Отримайте результати</strong><p>Частки, 95% довірчий інтервал і текст для вашої роботи.</p></div></li></ol><div className="verdict-legend"><span><i className="dot correct" />Правильно</span><span><i className="dot incorrect" />Неправильно</span><span><i className="dot unresolved" />Невизначено</span></div></section><section className="privacy-card"><HardDrive size={23} strokeWidth={1.5} /><div><h3>У вашому темпі, на вашому комп’ютері</h3><p>Повертайтеся до роботи в будь-який час. Збережені оцінки залишаються в локальній базі. Резервна копія переносить проєкт разом із даними.</p><button className="text-button" disabled={busy} onClick={onRestore}><RotateCcw size={14} />Відновити з резервної копії</button></div></section></aside>
    </div>
    <section className="projects-section"><div className="section-heading"><div><div className="eyebrow">ПРОДОВЖИТИ РОБОТУ</div><h2>Ваші проєкти <span>{projects.length.toString().padStart(2, "0")}</span></h2></div></div>{projects.length ? <div className="project-grid">{projects.map(p => <button className="project-card" key={p.id} disabled={busy} onClick={() => navigate(p.id)}><div><span className="icon-box"><FolderOpen size={19} /></span><span className={`pill ${p.completed === p.sampleSize ? "success" : ""}`}>{p.completed === p.sampleSize ? "Завершено" : "У роботі"}</span></div><h3>{p.name}</h3><p>{p.reviewer} · {new Date(p.createdAt).toLocaleDateString("uk-UA")}</p><Progress done={p.completed} total={p.sampleSize} /><div className="project-card-bottom"><span>{p.completed} / {p.sampleSize} перевірено</span><ArrowRight size={16} /></div></button>)}</div> : <div className="empty-projects"><FolderOpen size={21} /><span>Тут з’являться ваші перевірки. Почніть із нової вибірки вище.</span></div>}</section>
  </main>;
}

function QueueButton({ item, selected, disabled, onClick }: { item: QueueItem; selected: boolean; disabled: boolean; onClick: () => void }) {
  return <button className={`queue-item ${selected ? "selected" : ""}`} disabled={disabled} onClick={onClick} aria-current={selected ? "step" : undefined}><span className="queue-number">{String(item.position + 1).padStart(3, "0")}</span><span>{item.lemma}</span><span title={item.verdict ? VERDICTS[item.verdict] : "Не завершено"} aria-label={item.verdict ? VERDICTS[item.verdict] : "Не завершено"} className={`queue-status ${item.verdict ?? "pending"}`}>{item.verdict === "correct" ? <Check size={12} /> : item.verdict === "incorrect" ? <X size={11} /> : item.verdict === "unresolved" ? "?" : ""}</span></button>;
}

type ReviewProps = { item: ReviewItem; total: number; busy: boolean; onReveal: (choice: string) => Promise<void>; onSave: (assessment: Assessment, next: boolean) => Promise<void>; onPrevious: () => void; onNext: () => void };
function ReviewPane({ item, total, busy, onReveal, onSave, onPrevious, onNext }: ReviewProps) {
  const draftKey = `wsd:draft:${item.projectId}:${item.exampleId}`;
  const initialVerdict: Verdict = item.blindChoice === "uncertain" ? "unresolved" : item.blindChoice === item.assignedSenseId ? "correct" : "incorrect";
  const initial: { choice: string; assessment: Assessment } = { choice: item.blindChoice ?? "", assessment: item.assessment ?? { verdict: initialVerdict, reason: item.blindChoice === "none" ? "no_matching_definition" : "", replacementSenseId: item.blindChoice && item.options.some(o => o.id === item.blindChoice) && item.blindChoice !== item.assignedSenseId ? item.blindChoice : null, notes: "" } };
  const [draft] = useState(() => { try { const d = JSON.parse(localStorage.getItem(draftKey) ?? "null"); return d?.version === item.version ? d : null; } catch { return null; } });
  const [choice, setChoice] = useState<string>(draft?.choice ?? initial.choice);
  const [assessment, setAssessment] = useState<Assessment>(draft?.assessment ?? initial.assessment);
  const [draftSaved, setDraftSaved] = useState(false);
  const assessmentDirty = JSON.stringify(assessment) !== JSON.stringify(item.assessment);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ version: item.version, choice, assessment })); setDraftSaved(true); } catch { setDraftSaved(false); }
  }, [draftKey, item.version, choice, assessment]);
  const changeVerdict = useCallback((verdict: Verdict) => setAssessment(a => ({ ...a, verdict, reason: verdict === "correct" ? "" : a.reason === "no_matching_definition" && verdict === "unresolved" ? "" : a.reason, replacementSenseId: verdict === "incorrect" ? a.replacementSenseId : null })), []);
  const reasonValid = assessment.verdict !== "unresolved" || !!assessment.reason;
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if (busy) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (item.revealedAt && reasonValid) void onSave(assessment, true); else if (!item.revealedAt && choice) void onReveal(choice); return; }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); onPrevious(); return; }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); onNext(); return; }
      if (e.target instanceof HTMLElement && (e.target.matches("input,textarea,select") || e.target.isContentEditable)) return;
      const index = Number(e.key) - 1;
      if (!/^[1-9]$/.test(e.key)) return;
      if (item.revealedAt && index < 3) changeVerdict((["correct", "incorrect", "unresolved"] as const)[index]);
      else if (!item.revealedAt && index < item.options.length) setChoice(item.options[index].id);
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [assessment, busy, changeVerdict, choice, item, onNext, onPrevious, onReveal, onSave, reasonValid]);
  const assigned = item.options.find(o => o.id === item.assignedSenseId);
  const initialChoice = item.options.find(o => o.id === item.blindChoice)?.gloss ?? (item.blindChoice === "none" ? "Жодне значення не підходить" : "Не можу визначити однозначно");
  return <>
    <div className="review-topline"><span>ПРИКЛАД <strong>{String(item.position + 1).padStart(3, "0")}</strong> / {total}</span><span className={`phase-badge ${item.revealedAt ? "revealed" : ""}`}>{item.revealedAt ? <Eye size={13} /> : <LockKeyhole size={13} />}{item.revealedAt ? "Мітку відкрито" : "Сліпа перевірка"}</span></div>
    <section className="sentence-card"><div className="eyebrow">ЦІЛЬОВА ЛЕМА</div><h2>{item.lemma}</h2><div className="sentence-divider" /><blockquote>{item.sentence}</blockquote><div className="sentence-caption"><BookOpen size={14} />Оцініть цільове вживання в межах цього речення</div></section>
    <section className="definitions-section"><div className="definitions-heading"><div><div className="eyebrow">{item.revealedAt ? "ЗІСТАВЛЕННЯ ЗНАЧЕНЬ" : "КРОК 1 · ВАШЕ СУДЖЕННЯ"}</div><h3>{item.revealedAt ? "Початковий вибір зафіксовано" : "Яке значення має слово в реченні?"}</h3></div><span className="muted small-text">{item.options.length} визначення</span></div><fieldset className="definitions" disabled={busy || !!item.revealedAt}><legend className="sr-only">Виберіть значення леми</legend>{item.options.map((o, i) => <label className={`definition ${choice === o.id ? "chosen" : ""} ${item.assignedSenseId === o.id ? "assigned" : ""}`} key={o.id}><input type="radio" name="meaning" value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} /><span className="option-number">{i + 1}</span><span className="definition-text">{o.gloss}{item.assignedSenseId === o.id && <span className="assignment-label">Автоматична мітка</span>}{item.revealedAt && item.blindChoice === o.id && <span className="initial-label">Ваш початковий вибір</span>}</span><span className="radio-mark">{choice === o.id && <span />}</span></label>)}<div className="special-choices"><label className={choice === "none" ? "chosen" : ""}><input type="radio" name="meaning" checked={choice === "none"} onChange={() => setChoice("none")} /><X size={15} />Жодне значення не підходить</label><label className={choice === "uncertain" ? "chosen" : ""}><input type="radio" name="meaning" checked={choice === "uncertain"} onChange={() => setChoice("uncertain")} /><CircleHelp size={15} />Не можу визначити однозначно</label></div></fieldset>
      {!item.revealedAt ? <div className="reveal-row"><p><LockKeyhole size={14} />Ваше перше рішення збережеться до відкриття мітки.</p><button className="button primary" disabled={busy || !choice} onClick={() => onReveal(choice)}><Eye size={16} />Зафіксувати й відкрити мітку</button></div> : <>
        <div className="comparison-note"><CheckCircle2 size={18} /><div><strong>Ваше початкове судження:</strong> {initialChoice}<br /><span className="muted">Автоматично призначено: {assigned?.gloss}</span></div></div>
        <section className="assessment-section"><div className="eyebrow">КРОК 2 · ПІДСУМКОВА ОЦІНКА</div><h3>Чи відповідає автоматична мітка вживанню?</h3><fieldset className="verdict-options" disabled={busy}><legend className="sr-only">Підсумкова оцінка</legend>{(["correct", "incorrect", "unresolved"] as const).map((v, i) => <label key={v} className={`verdict-option ${v} ${assessment.verdict === v ? "active" : ""}`}><input type="radio" name="verdict" checked={assessment.verdict === v} onChange={() => changeVerdict(v)} />{v === "correct" ? <CheckCircle2 size={18} /> : v === "incorrect" ? <X size={18} /> : <CircleHelp size={18} />}<span>{VERDICTS[v]}</span><kbd>{i + 1}</kbd></label>)}</fieldset>
        {assessment.verdict !== "correct" && <div className="form-grid"><label>Причина {assessment.verdict === "unresolved" ? "*" : "(необов’язково)"}<select value={assessment.reason} disabled={busy} onChange={e => setAssessment(a => ({ ...a, reason: e.target.value as Assessment["reason"] }))}><option value="">Оберіть причину</option>{Object.entries(REASONS).filter(([key]) => assessment.verdict === "incorrect" || key !== "no_matching_definition").map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label>{assessment.verdict === "incorrect" && <label>Запропоноване значення<select disabled={busy} value={assessment.replacementSenseId ?? ""} onChange={e => setAssessment(a => ({ ...a, replacementSenseId: e.target.value || null }))}><option value="">Без запропонованого виправлення</option>{item.options.filter(o => o.id !== item.assignedSenseId).map(o => <option key={o.id} value={o.id}>{o.gloss}</option>)}</select></label>}</div>}
        <label className="notes-label">Примітка <span>(необов’язково)</span><textarea disabled={busy} maxLength={10000} rows={3} placeholder="Що допомогло ухвалити рішення або викликало сумнів…" value={assessment.notes} onChange={e => setAssessment(a => ({ ...a, notes: e.target.value }))} /></label>
        <div className="save-row"><span className="save-status">{item.assessment && !assessmentDirty ? <><CheckCircle2 size={14} />Оцінку збережено · версія {item.version}</> : draftSaved ? "Чернетка в браузері · натисніть «Зберегти»" : "Чернетку ще не збережено в базі"}</span><div><button className="button secondary" disabled={busy || !reasonValid} onClick={() => onSave(assessment, false)}>Зберегти</button><button className="button primary" disabled={busy || !reasonValid} onClick={() => onSave(assessment, true)}>Зберегти й далі<ArrowRight size={16} /></button></div></div></section>
        <details className="source-details"><summary><Database size={15} />Джерело GRAC</summary><dl>{[["Документ", item.grac?.document_title], ["Автор", item.grac?.document_author], ["Рік", item.grac?.publication_year], ["ID документа", item.grac?.document_id], ["ID речення", item.grac?.sentence_id]].filter(([, value]) => value != null).map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{String(value)}</dd></div>)}</dl>{typeof item.grac?.document_url === "string" && /^https?:\/\//.test(item.grac.document_url) && <a href={item.grac.document_url} target="_blank" rel="noreferrer">Посилання на джерело ↗</a>}<p className="muted small-text">Підсумкова оцінка стосується лише речення з бенчмарку.</p></details>
        {!!item.history?.length && <details className="source-details"><summary><HistoryIcon size={15} />Історія збережень ({item.history.length})</summary><ol className="history-list">{item.history.map(h => { const d = JSON.parse(h.data); return <li key={h.id}><strong>Версія {d.version} · {h.type === "reveal" ? "Початковий вибір і відкриття мітки" : VERDICTS[d.verdict as Verdict]}</strong><time>{new Date(h.at).toLocaleString("uk-UA")}</time>{d.notes && <p>{d.notes}</p>}</li>; })}</ol></details>}
      </>}
    </section>
    <div className="item-navigation"><button className="text-button" disabled={busy || item.position === 0} onClick={onPrevious}><ArrowLeft size={15} />Попередній</button><span><kbd>1–9</kbd> вибір <span className="keyboard-extra">· <kbd>Ctrl / ⌘ ↵</kbd> зберегти · <kbd>Alt ← →</kbd> навігація</span></span><button className="text-button" disabled={busy || item.position >= total - 1} onClick={onNext}>Наступний<ArrowRight size={15} /></button></div>
  </>;
}

function ResultsPanel({ results: r, onContinue }: { results: Results; onContinue: () => void }) {
  const [paragraph, setParagraph] = useState("");
  const [reportError, setReportError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setParagraph(""); setReportError("");
    if (!r.complete) return;
    const controller = new AbortController();
    api<{ paragraph: string }>(`projects/${r.project.id}/report`, undefined, controller.signal).then(d => setParagraph(d.paragraph)).catch(e => { if (e.name !== "AbortError") setReportError(e.message); });
    return () => controller.abort();
  }, [r.project.id, r.complete, r.counts.correct, r.counts.incorrect, r.counts.unresolved]);
  const exports = [{ format: "csv", label: "Анотації CSV", icon: <ArrowDownToLine size={17} /> }, { format: "results", label: "Результати JSON", icon: <Database size={17} /> }, { format: "backup", label: "Резервна копія", icon: <HardDrive size={17} /> }];
  return <main className="results-main"><div className="results-intro"><div><div className="eyebrow">{r.complete ? "ПЕРЕВІРКУ ЗАВЕРШЕНО" : "ПРОМІЖНІ РЕЗУЛЬТАТИ"}</div><h2>{r.complete ? "Від суджень — до висновків." : "Кожне рішення має значення."}</h2><p className="muted">{r.complete ? "Результати авторської перевірки зафіксованої випадкової вибірки." : "Фінальна оцінка та довірчий інтервал з’являться після перевірки всієї вибірки."}</p></div>{!r.complete && <button className="button primary" onClick={onContinue}>Продовжити перевірку<ArrowRight size={17} /></button>}</div><div className="result-cards"><div className="result-card headline-card"><span>Підтверджені відповідності</span><strong>{r.confirmedProportion !== null ? percent(r.confirmedProportion) : "—"}</strong><p>{r.interval ? `95% ДІ: ${percent(r.interval.lower, 2)}–${percent(r.interval.upper, 2)}` : `Завершено ${r.completed} із ${r.project.sampleSize}`}</p></div>{(["correct", "incorrect", "unresolved"] as const).map(v => <div className={`result-card ${v}`} key={v}><span><i className={`dot ${v}`} />{VERDICTS[v]}</span><strong>{r.counts[v]}</strong><p>{percent(r.percentages[v])} усієї вибірки</p></div>)}</div><div className="results-grid"><section className="panel"><div className="card-title"><span className="icon-box"><FileText size={19} /></span><div><h3>Текст для дослідження</h3><p>Процедура, результати та межі висновків</p></div></div>{r.complete ? <>{reportError && <p role="alert">{reportError}</p>}<p className="report-paragraph">{paragraph || "Готуємо текст…"}</p><div className="report-actions"><button className="button secondary small" disabled={!paragraph} onClick={async () => { try { await navigator.clipboard.writeText(paragraph); setCopied(true); } catch { setReportError("Не вдалося скопіювати. Завантажте Markdown або виділіть текст."); } }}>{copied ? "Скопійовано" : "Копіювати текст"}</button><a className="button primary small" href={`/api/projects/${r.project.id}/export?format=markdown`}><ArrowDownToLine size={14} />Звіт Markdown</a></div></> : <div className="report-pending"><LockKeyhole size={28} strokeWidth={1.4} /><h3>Ще {r.counts.pending} прикладів до повного звіту</h3><p>Пропущені та відкриті без оцінки приклади залишаються в черзі. Невизначені випадки вважаються завершеними.</p><Progress done={r.completed} total={r.project.sampleSize} /></div>}</section><section className="panel reproducibility"><div className="eyebrow">ВІДТВОРЮВАНІСТЬ</div><h3>Паспорт перевірки</h3><dl><div><dt>Вибірка / сукупність</dt><dd>{count(r.project.sampleSize)} / {count(r.snapshot.population)}</dd></div><div><dt>Охоплено лем / значень</dt><dd>{r.coverage.lemmas} / {r.coverage.senses}</dd></div><div><dt>Seed</dt><dd>{r.project.seed}</dd></div><div><dt>Ревізія</dt><dd className="mono">{r.snapshot.revision ?? "Локальний імпорт"}</dd></div><div><dt>SHA-256</dt><dd className="mono">{r.snapshot.checksum}</dd></div></dl><details className="advanced"><summary>Метод оцінювання</summary><p>Проста випадкова вибірка без повернення. Частка підтверджених міток: правильні / вся вибірка. Невизначені випадки залишаються у знаменнику й не прирівнюються до доведених помилок.</p><p>95% довірчий інтервал: інверсія рівнохвостих гіпергеометричних тестів для скінченної сукупності. Це інтервал частки підтверджених міток за судженнями цього перевіряльника.</p><p className="mono">{r.project.sampler}</p></details>{!!r.counts.unresolved && <div className="reason-summary"><h4>Причини невизначеності</h4>{Object.entries(r.unresolvedReasons).map(([key, value]) => <p key={key}><span>{REASONS[key]}</span><strong>{value}</strong></p>)}</div>}</section></div><section className="export-strip"><div><h3>Заберіть результати з собою</h3><p>CSV для аналізу · JSON для відновлення та відтворюваності</p></div><div>{exports.map(e => <a key={e.format} className="button secondary" href={`/api/projects/${r.project.id}/export?format=${e.format}`}>{e.icon}{e.label}</a>)}</div></section><div className="limitations"><CircleHelp size={18} /><p>Це авторська перевірка збережених прикладів. Вона не оцінює узгодженість між перевіряльниками, якість кожного значення окремо або повноту добору контекстів. У формі показано визначення, збережені в бенчмарку. Резервна копія містить повний знімок даних і журнал змін.</p></div></main>;
}
