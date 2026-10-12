// jev_find for Pi: "where is the code for X?" over the checkout Pi works in,
// answered by Jev (TypeSafe's System One) in about a second. The search is
// find.ts, the same code Thunder Foundry's workers run. This file lists the
// checkout's files, calls Jev, and registers the tool.
//
// The key is Pi's own: `typesafe` in ~/.pi/agent/auth.json, or
// TYPESAFE_API_KEY, looked up when a session starts.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findCode, isSource, limited, MAX_FILE_BYTES, renderFound, skeleton, type Ask } from "./find.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export const DESCRIPTION =
  "Find the code a question is about, across the whole repository, in a few seconds. Describe what you are looking for in words: a behaviour, a definition, where a change belongs, the likely cause of a failure. Returns the most relevant files with scores (probabilities: near 1 is relevant, near 0 is not) and the best excerpts with line numbers, which often make a read unnecessary. If it finds nothing relevant, trust that and look elsewhere. Tests, fixtures and docs are left out unless you pass paths. For an exact name or string, grep is faster and certain.";

// One call to Jev, retried on 429 and 5xx with backoff.
export function jevClient(apiKey: string, maxAttempts = 5, doFetch: typeof fetch = fetch): Ask {
  return async (state, questions, purpose) => {
    for (let attempt = 1; ; attempt++) {
      const response = await doFetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body.answers ?? {};
      if ((response.status !== 429 && response.status < 500) || attempt >= maxAttempts) {
        throw new Error(`jev ${purpose}: ${body.error?.message ?? `HTTP ${response.status}`}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(8_000, 250 * 2 ** attempt) * (0.5 + Math.random())));
    }
  };
}

// A checkout's tracked source files, optionally limited to git pathspecs.
export function listFiles(cwd: string, pathspecs: string[] = []): { path: string; text: string }[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const files: { path: string; text: string }[] = [];
  for (const path of out.split("\0").filter(Boolean)) {
    try {
      const s = statSync(join(cwd, path));
      if (!s.isFile() || s.size === 0 || s.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    const text = readFileSync(join(cwd, path), "utf8");
    if (isSource(path, text)) files.push({ path, text });
  }
  return files;
}

export async function search(ask: Ask, query: string, cwd: string, paths: string[] = []): Promise<string> {
  const files = listFiles(cwd, paths);
  if (!files.length) return `No source files match ${paths.length ? paths.join(", ") : "in this repository"}.`;
  const texts = new Map(files.map((f) => [f.path, f.text]));
  const outlines = files.map((f) => ({ path: f.path, skeleton: skeleton(f.path, f.text) }));
  const ranked = await findCode(query, outlines, { ask, read: async (p) => texts.get(p) ?? null, skipTests: !paths.length });
  return renderFound(query, ranked, files.length);
}

export default function jevFind(pi: ExtensionAPI) {
  let ask: Ask | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("typesafe");
    ask = apiKey ? limited(jevClient(apiKey)) : undefined;
  });

  pi.registerTool({
    name: "jev_find",
    label: "Jev find",
    description: DESCRIPTION,
    promptSnippet: "Find the code a question is about, ranked, with excerpts",
    parameters: Type.Object({
      query: Type.String({ description: "What you are looking for, in words. Say 'implementation, not tests' if that matters." }),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Limit the search to these git pathspecs, such as ['src/', '*.py']" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ask) throw new Error("Jev has no key: add typesafe to ~/.pi/agent/auth.json, or set TYPESAFE_API_KEY. Use grep and find meanwhile.");
      const query = params.query.trim();
      if (!query) throw new Error("query is empty: say in words what you are looking for.");
      return { content: [{ type: "text", text: await search(ask, query, ctx.cwd, params.paths ?? []) }], details: {} };
    },
  });
}
