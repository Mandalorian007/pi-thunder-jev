import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ask } from "../find.ts";
import { jevClient, listFiles, search } from "../index.ts";

// A checkout with one file about billing, one about logins, a test and a lockfile.
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "src/billing.ts"), "// Charges a card.\nexport function charge(cents: number) {\n  return cents;\n}\n");
  writeFileSync(join(dir, "src/login.ts"), "// Signs a user in.\nexport function login(name: string) {\n  return name;\n}\n");
  writeFileSync(join(dir, "tests/billing.test.ts"), "charge(1);\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

// A scripted Jev: yes to whatever mentions billing or charge, no to the rest.
const scripted: Ask = async (state) => {
  const items = ((state as { files?: Record<string, string>; chunks?: Record<string, string> }).files ??
    (state as { chunks: Record<string, string> }).chunks) as Record<string, string>;
  return Object.fromEntries(Object.entries(items).map(([id, text]) => [id, { noul: /billing|charge/i.test(text) ? 0.95 : 0.05 }]));
};

test("lists tracked source files, without lockfiles", () => {
  const paths = listFiles(checkout()).map((f) => f.path).sort();
  assert.deepEqual(paths, ["src/billing.ts", "src/login.ts", "tests/billing.test.ts"]);
});

test("finds the file a question is about, with an excerpt, and leaves tests out", async () => {
  const text = await search(scripted, "where are cards charged?", checkout());
  assert.match(text, /^Top files for: where are cards charged\?/);
  assert.match(text, /0\.95 {2}src\/billing\.ts/);
  assert.match(text, /export function charge/);
  assert.doesNotMatch(text, /tests\/billing/);
});

test("says nothing was found when nothing scores", async () => {
  const text = await search(async (state) => Object.fromEntries(Object.keys((state as { files?: object; chunks?: object }).files ?? (state as { chunks: object }).chunks).map((id) => [id, { noul: 0.1 }])), "payroll", checkout());
  assert.match(text, /^Nothing relevant found in 3 files/);
});

test("the client retries a 429 and sends the key", async () => {
  const seen: string[] = [];
  let calls = 0;
  const fake = (async (_url: string, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).Authorization));
    calls++;
    return calls === 1 ? new Response("{}", { status: 429 }) : Response.json({ answers: { a: { noul: 0.9 } } });
  }) as typeof fetch;
  const answers = await jevClient("k", 3, fake)({}, { a: { type: "noul", instructions: "?" } }, "test");
  assert.deepEqual(answers, { a: { noul: 0.9 } });
  assert.equal(calls, 2);
  assert.deepEqual(seen, ["Bearer k", "Bearer k"]);
});
