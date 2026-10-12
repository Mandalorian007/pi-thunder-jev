// Finding the code a question is about, with Jev. Copied from Thunder
// Foundry (convex/lib/jevFind.ts), where it backs the workers' jev_find. Two
// passes, both Noul questions answered as probabilities:
//
//   1. Every source file's skeleton (its path, leading comment and declaration
//      lines, at most 600 characters) is asked "is this the file the question
//      is about?", many files to a call. Tests, fixtures and docs are left out
//      unless the caller names paths.
//   2. The best eight files are cut into chunks of at most 40 lines, and every
//      chunk is asked the same of itself. Files rank by their best chunk.
//
// A best score under 0.65 is reported as nothing found, which is evidence of
// absence an agent can act on. Measured in Thunder Foundry's experiments: its
// Software Factory's plan stage told to start here read 108K characters fewer
// and cost 22% less per task, with no loss in tasks resolved.
//
// No imports and nothing but plain data in and out.

export type JevNoul = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type Ask = (state: unknown, questions: Record<string, JevNoul>, purpose: string) => Promise<Record<string, { noul?: number } | undefined>>;

export type Outline = { path: string; skeleton: string };
export type Chunk = { id: string; path: string; start: number; end: number; text: string };
export type Scored<T> = T & { score: number };
export type FileHit = { path: string; score: number; chunks: Scored<Chunk>[] };

export const ABSENT_BELOW = 0.65;
export const SKELETON_CHARS = 600;
export const TOP_FILES = 8;
export const WINDOW_CHARS = 24_000;
export const MAX_FILE_BYTES = 600_000;

// Not source: dependencies, builds, lockfiles, minified or binary files.
export const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.git)\/|(\.lock|\.lockb|-lock\.json|\.min\.js|\.map|\.svg|\.png|\.jpe?g|\.gif|\.ico|\.woff2?|\.ttf|\.pdf|\.zip|\.gz|\.mo|\.po|\.pyc|\.snap)$/i;
// Rarely what a question is about, and a third of a large repository.
export const TESTISH = /(^|\/)(tests?|__tests__|e2e|testdata|fixtures?|docs?|examples?|benches)\/|[._-](test|spec)s?\.\w+$|_test\.\w+$|(^|\/)test_\w+\.py$/;
export const DECL =
  /^\s{0,4}(export\s|async\s|def\s|class\s|function\s|interface\s|type\s|const\s|let\s|enum\s|struct\s|impl\s|fn\s|pub\s|func\s|module\s|public\s|private\s|protected\s|static\s|abstract\s|@\w)/;
const COMMENT = /^\s*(\/\/|#|\/\*|\*|"""|''')/;

// Minified or generated: very long lines on average.
export const isSource = (path: string, text: string) => !SKIP.test(path) && !text.includes("\u0000") && text.length / text.split("\n").length <= 400;

// What a file is about, cheaply: its path, its leading comment, and its
// declaration lines (or, for data, its first lines), up to `maxChars`.
export function skeleton(path: string, text: string, maxChars = SKELETON_CHARS): string {
  const lines = text.split("\n");
  const head: string[] = [];
  for (const line of lines.slice(0, 12)) {
    if (COMMENT.test(line) && line.trim().length > 3) head.push(line.trim());
    else if (head.length) break;
  }
  const decls = lines.filter((l) => DECL.test(l)).map((l) => l.trimEnd().slice(0, 160));
  const body = decls.length ? decls : lines.slice(0, 15).map((l) => l.slice(0, 160));
  const out = `${path} (${lines.length} lines)\n${head.slice(0, 4).join("\n")}${head.length ? "\n" : ""}${body.join("\n")}`;
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…` : out;
}

// Chunks of at most `maxLines` lines, cut just after a blank line in the last
// half of the window where there is one.
export function chunkFile(path: string, text: string, maxLines = 40): Chunk[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    if (end < lines.length) {
      for (let i = end - 1; i > start + maxLines / 2; i--) {
        if (lines[i].trim() === "") {
          end = i + 1;
          break;
        }
      }
    }
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) chunks.push({ id: "", path, start: start + 1, end, text: body });
    start = end;
  }
  return chunks;
}

// Items packed into windows of at most `windowChars` (one call each), in
// order, so neighbours share a call.
export function pack<T>(items: T[], size: (item: T) => number, windowChars = WINDOW_CHARS, maxPerWindow = 64): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length && (chars + n > windowChars || current.length >= maxPerWindow)) {
      windows.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += n;
  }
  if (current.length) windows.push(current);
  return windows;
}

// At most `n` calls in flight, so a fan-out over a large repository never
// floods the API.
export function limited(ask: Ask, n = 16): Ask {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (state, questions, purpose) => {
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await ask(state, questions, purpose);
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const CHUNK_Q = {
  true: "This code is what the question is about: it implements, defines, configures or tests the behaviour asked about, so it must be read or changed to answer it",
  false: "This code does something else, even if it shares words or names with the question",
};
const FILE_Q = {
  true: "Answering the question means reading or changing this file: it holds the behaviour, definition or test the question is about",
  false: "This file is about something else, even if it shares words with the question",
};

// Skeletons, with what "relevant" means stated once in the state rather than
// in every question: 10-17% cheaper at the same accuracy.
export async function judgeFiles(ask: Ask, question: string, outlines: Outline[], purpose = "find:files", windowChars = WINDOW_CHARS) {
  const items = outlines.map((o, i) => ({ id: `f${i}`, ...o }));
  const windows = pack(items, (x) => x.skeleton.length + 10, windowChars);
  const scored = await Promise.all(
    windows.map(async (w) => {
      const state = { question, relevant: `Yes: ${FILE_Q.true}. No: ${FILE_Q.false}.`, files: Object.fromEntries(w.map((x) => [x.id, x.skeleton])) };
      const questions = Object.fromEntries(w.map((x) => [x.id, { type: "noul" as const, instructions: `Is \`files.${x.id}\` relevant to \`question\`, as \`relevant\` defines?` }]));
      const answers = await ask(state, questions, purpose);
      return w.map((x) => ({ path: x.path, score: answers[x.id]?.noul ?? 0 }));
    }),
  );
  return scored.flat().sort((a, b) => b.score - a.score);
}

// Chunks keep the criteria in every question, which is what makes their
// scores good for saying nothing is there.
export async function judgeChunks(ask: Ask, question: string, chunks: Chunk[], purpose = "find:chunks", windowChars = WINDOW_CHARS): Promise<Scored<Chunk>[]> {
  const windows = pack(chunks, (c) => c.text.length + c.path.length + 20, windowChars);
  const scored = await Promise.all(
    windows.map(async (w) => {
      const state = { question, chunks: Object.fromEntries(w.map((c) => [c.id, `${c.path}:${c.start}-${c.end}\n${c.text}`])) };
      const questions = Object.fromEntries(w.map((c) => [c.id, { type: "noul" as const, instructions: `Is \`chunks.${c.id}\` code that \`question\` is about?`, criteria: CHUNK_Q }]));
      const answers = await ask(state, questions, purpose);
      return w.map((c) => ({ ...c, score: answers[c.id]?.noul ?? 0 }));
    }),
  );
  return scored.flat();
}

// Chunks grouped by file, files ranked by their best chunk; ties (common at
// 0.99) go to the file with more strong chunks.
export function byFile(chunks: Scored<Chunk>[]): FileHit[] {
  const files = new Map<string, FileHit>();
  for (const c of chunks) {
    const f = files.get(c.path) ?? { path: c.path, score: 0, chunks: [] };
    f.chunks.push(c);
    f.score = Math.max(f.score, c.score);
    files.set(c.path, f);
  }
  for (const f of files.values()) f.chunks.sort((a, b) => b.score - a.score);
  const strength = (f: FileHit) => f.score + 0.01 * f.chunks.filter((c) => c.score > 0.5).length;
  return [...files.values()].sort((a, b) => strength(b) - strength(a));
}

export type FindOptions = {
  ask: Ask;
  // A file's whole text, for the files the first pass keeps.
  read: (path: string) => Promise<string | null>;
  // Leave tests, fixtures and docs out of the first pass.
  skipTests?: boolean;
  topFiles?: number;
};

export async function findCode(question: string, outlines: Outline[], opts: FindOptions): Promise<FileHit[]> {
  const first = opts.skipTests ? outlines.filter((o) => !TESTISH.test(o.path)) : outlines;
  const files = await judgeFiles(opts.ask, question, first);
  const top = files.slice(0, opts.topFiles ?? TOP_FILES);
  const texts = await Promise.all(top.map(async (f) => ({ path: f.path, text: await opts.read(f.path) })));
  const chunks = texts.flatMap((t) => (t.text === null ? [] : chunkFile(t.path, t.text)));
  chunks.forEach((c, i) => (c.id = `c${i}`));
  const ranked = byFile(await judgeChunks(opts.ask, question, chunks));
  // Files the second pass did not read still rank, below, at half their skeleton score.
  const seen = new Set(ranked.map((f) => f.path));
  ranked.push(...files.filter((f) => !seen.has(f.path)).map((f) => ({ path: f.path, score: f.score * 0.5, chunks: [] })));
  return ranked;
}

const numbered = (text: string, start: number) =>
  text
    .split("\n")
    .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
    .join("\n");

// What the agent sees: the files that matter with their strong line ranges,
// the next best score, and the three best excerpts, so a read is often
// unnecessary. Or, under the bar, that nothing was found.
export function renderFound(question: string, ranked: FileHit[], searched: number, absentBelow = ABSENT_BELOW): string {
  const best = ranked[0]?.score ?? 0;
  if (best < absentBelow) {
    const weak = ranked
      .slice(0, 3)
      .map((f) => `  ${f.score.toFixed(2)}  ${f.path}`)
      .join("\n");
    return `Nothing relevant found in ${searched} files: no strong match (best ${best.toFixed(2)}). The code you describe may not exist here; try other words, or grep for an exact string.${weak ? ` Weak candidates:\n${weak}` : ""}`;
  }
  const shown = ranked.filter((f) => f.score >= absentBelow).slice(0, 6);
  const rest = ranked.find((f) => !shown.includes(f));
  const lines = [`Top files for: ${question.slice(0, 200)}`];
  for (const f of shown) {
    const strong = f.chunks.filter((c) => c.score >= absentBelow).map((c) => `${c.start}-${c.end}`);
    lines.push(`  ${f.score.toFixed(2)}  ${f.path}${strong.length ? `  (lines ${strong.slice(0, 4).join(", ")})` : ""}`);
  }
  if (rest) lines.push(`  next best: ${rest.score.toFixed(2)} ${rest.path}`);
  const excerpts = shown
    .flatMap((f) => f.chunks)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const c of excerpts) lines.push(`\n${c.path}:${c.start}-${c.end} (${c.score.toFixed(2)})\n${numbered(c.text, c.start)}`);
  return lines.join("\n");
}
