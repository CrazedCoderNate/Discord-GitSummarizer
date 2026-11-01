import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;

const MODEL = process.env.MODEL ?? "claude-haiku-5-5";
const MAX_COMMITS = Number(process.env.MAX_COMMITS_PER_PUSH ?? 5);
const MAX_DIFF_CHARS = Number(process.env.MAX_DIFF_CHARS ?? 12_000);

// Haiku thinks adaptively and its thinking counts toward max_tokens, so leave
// headroom. Too low and you get stop_reason "max_tokens" with no usable JSON.
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 1200);
// low | medium | high. Controls how much Haiku thinks before answering; a commit
// summary does not need more than low.
const EFFORT = process.env.EFFORT ?? "low";

// optional "main,develop" allowlist. empty = every branch
const BRANCH_FILTER = (process.env.BRANCH_FILTER ?? "")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

const SKIP_MERGE_COMMITS = process.env.SKIP_MERGE_COMMITS !== "false";

// files whose diffs are noise and burn tokens for nothing
const NOISE_PATHS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /go\.sum$/,
  /Cargo\.lock$/,
  /\.min\.(js|css)$/,
  /^dist\//,
  /^build\//,
];

const COLORS = { low: 0x3fb950, medium: 0xd29922, high: 0xf85149 } as const;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

type Risk = keyof typeof COLORS;

interface PushCommit {
  id: string;
  message: string;
  url: string;
  timestamp: string;
  author: { name: string; username?: string };
  added: string[];
  modified: string[];
  removed: string[];
}

interface PushPayload {
  ref: string;
  deleted: boolean;
  forced: boolean;
  commits: PushCommit[];
  head_commit: PushCommit | null;
  compare: string;
  repository: { full_name: string; html_url: string; private: boolean };
  pusher: { name: string };
  sender: { login: string; avatar_url: string };
}

interface Explanation {
  headline: string;
  bullets: string[];
  risk: Risk;
  risk_note: string;
}

interface ClaudeResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

// Vercel's Node runtime invokes this as (req, res). Returning a Response object
// from a Web-style handler here does nothing: res is never written, the request
// hangs until maxDuration, and the build still reports green.
//
// bodyParser must be off. HMAC is computed over the exact bytes GitHub sent, so
// anything that parses and re-serializes the body first breaks verification.
export const config = { api: { bodyParser: false } };

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }

  const raw = await readRawBody(req);

  if (!verifySignature(raw, header(req, "x-hub-signature-256"))) {
    res.statusCode = 401;
    res.end("bad signature");
    return;
  }

  const event = header(req, "x-github-event");
  if (event === "ping") {
    res.statusCode = 200;
    res.end("pong");
    return;
  }
  if (event !== "push") {
    res.statusCode = 200;
    res.end("ignored");
    return;
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    res.end("bad json");
    return;
  }

  // GitHub gives you ~10s before it marks the delivery failed. The LLM round
  // trips take longer than that, so ack immediately and finish in background.
  waitUntil(
    processPush(payload).catch((err) => console.error("processPush failed", err)),
  );

  res.statusCode = 202;
  res.end("ok");
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* signature verification                                              */
/* ------------------------------------------------------------------ */

function verifySignature(body: string, header: string | null): boolean {
  if (!header || !WEBHOOK_SECRET) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* pipeline                                                            */
/* ------------------------------------------------------------------ */

// exported so test/smoke.ts can await the background half of the pipeline, which
// is otherwise handed to waitUntil() and unobservable from the caller.
export async function processPush(p: PushPayload): Promise<void> {
  if (p.deleted || !p.commits?.length) return;

  const branch = p.ref.replace("refs/heads/", "");
  if (!p.ref.startsWith("refs/heads/")) return; // tags
  if (BRANCH_FILTER.length && !BRANCH_FILTER.includes(branch)) return;

  let commits = p.commits;
  if (SKIP_MERGE_COMMITS) {
    commits = commits.filter((c) => !/^Merge (branch|pull request|remote)/i.test(c.message));
  }
  if (!commits.length) return;

  // A 40 commit push does not need 40 LLM calls. Explain the newest few in
  // detail, roll up the rest into one digest.
  const detailed = commits.slice(-MAX_COMMITS).reverse();
  const overflow = commits.length - detailed.length;

  const embeds: unknown[] = [];

  for (const commit of detailed) {
    const diff = await fetchDiff(p.repository.full_name, commit.id);
    const explanation = await explainCommit(commit, diff, p.repository.full_name);
    embeds.push(buildEmbed(commit, explanation, p, branch, diff.truncated));
  }

  if (overflow > 0) {
    embeds.push({
      color: 0x8b949e,
      description:
        `plus ${overflow} earlier commit${overflow === 1 ? "" : "s"} in this push ` +
        `([compare](${p.compare}))`,
    });
  }

  await postToDiscord(embeds);
}

/* ------------------------------------------------------------------ */
/* github                                                              */
/* ------------------------------------------------------------------ */

async function fetchDiff(
  repoFullName: string,
  sha: string,
): Promise<{ text: string; truncated: boolean }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.diff",
    "User-Agent": "commit-explainer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits/${sha}`, {
    headers,
  });

  if (!res.ok) {
    console.error(`diff fetch ${sha} -> ${res.status}`);
    return { text: "", truncated: false };
  }

  const full = stripNoise(await res.text());
  if (full.length <= MAX_DIFF_CHARS) return { text: full, truncated: false };
  return { text: full.slice(0, MAX_DIFF_CHARS), truncated: true };
}

// drop lockfile / build-output hunks before they hit the token counter
function stripNoise(diff: string): string {
  const chunks = diff.split(/(?=^diff --git )/m);
  return chunks
    .filter((chunk) => {
      const m = chunk.match(/^diff --git a\/(\S+)/);
      if (!m) return true;
      return !NOISE_PATHS.some((re) => re.test(m[1]));
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* llm                                                                 */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You explain git commits to engineers skimming a Discord feed. You receive a commit message and its unified diff.

Rules:
- headline: max 90 chars, plain English, what the code now does. Do not restate the commit message verbatim.
- bullets: 2 to 4 items, max 130 chars each. Name the actual functions, files, endpoints, env vars, or queries that changed. Explain consequence, not just mechanics.
- risk: "high" for auth, secrets, permissions, data deletion, schema migrations, infra or IAM changes, or anything that can take prod down. "medium" for behavior changes to shared code paths, dependency bumps, config changes. "low" for tests, docs, formatting, isolated additions.
- risk_note: max 150 chars, only if risk is medium or high. Otherwise return an empty string.
- If the diff is empty or unavailable, infer conservatively from the commit message and say so in a bullet.
- No emoji. No filler like "this commit". Write like a senior reviewer leaving a note.`;

// Structured outputs: the API constrains decoding to this schema, so the text
// block is always parseable JSON in this shape. Objects must set
// additionalProperties: false.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    risk_note: { type: "string" },
  },
  required: ["headline", "bullets", "risk", "risk_note"],
  additionalProperties: false,
};

async function explainCommit(
  commit: PushCommit,
  diff: { text: string; truncated: boolean },
  repo: string,
): Promise<Explanation> {
  const userContent = [
    `Repo: ${repo}`,
    `Author: ${commit.author.name}`,
    `Commit message:\n${commit.message}`,
    `Files: +${commit.added.length} ~${commit.modified.length} -${commit.removed.length}`,
    diff.truncated ? "NOTE: diff below is truncated." : "",
    "",
    "Diff:",
    diff.text || "(no diff available)",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      // no temperature: current Claude models reject sampling params alongside thinking
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        output_config: {
          effort: EFFORT,
          format: { type: "json_schema", schema: RESPONSE_SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      console.error(`claude ${res.status}: ${await res.text()}`);
      return fallback(commit);
    }

    const data = (await res.json()) as ClaudeResponse;

    const u = data.usage;
    if (u) {
      console.log(
        `claude tokens in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
          `stop=${data.stop_reason} sha=${commit.id.slice(0, 7)}`,
      );
    }

    // a refusal or a cut-off answer can break the schema; fall back rather than guess
    if (data.stop_reason === "refusal" || data.stop_reason === "max_tokens") {
      console.error(`claude stop_reason=${data.stop_reason}`);
      return fallback(commit);
    }

    // thinking blocks come first; only the text block carries the JSON
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    if (!text) {
      console.error(`claude empty response, stop_reason=${data.stop_reason}`);
      return fallback(commit);
    }

    return normalize(JSON.parse(text));
  } catch (err) {
    console.error("explainCommit failed", err);
    return fallback(commit);
  }
}


function normalize(raw: Partial<Explanation>): Explanation {
  // structured outputs do not guarantee enum casing, so compare case-insensitively
  const r = String(raw.risk ?? "").toLowerCase();
  const risk: Risk = ["low", "medium", "high"].includes(r) ? (r as Risk) : "low";
  return {
    headline: String(raw.headline ?? "").slice(0, 200) || "No summary available",
    bullets: (Array.isArray(raw.bullets) ? raw.bullets : []).slice(0, 4).map(String),
    risk,
    risk_note: String(raw.risk_note ?? "").slice(0, 200),
  };
}

function fallback(commit: PushCommit): Explanation {
  return {
    headline: commit.message.split("\n")[0].slice(0, 200),
    bullets: ["Automatic explanation unavailable. Open the commit to review the diff."],
    risk: "low",
    risk_note: "",
  };
}

/* ------------------------------------------------------------------ */
/* discord                                                             */
/* ------------------------------------------------------------------ */

function buildEmbed(
  commit: PushCommit,
  ex: Explanation,
  p: PushPayload,
  branch: string,
  truncated: boolean,
) {
  const lines = [
    `**${ex.headline}**`,
    "",
    ...ex.bullets.map((b) => `• ${b}`),
  ];

  if (ex.risk !== "low" && ex.risk_note) {
    lines.push("", `⚠ **${ex.risk.toUpperCase()} RISK:** ${ex.risk_note}`);
  }
  if (truncated) lines.push("", "_diff truncated for length_");

  return {
    title: commit.message.split("\n")[0].slice(0, 250),
    url: commit.url,
    color: COLORS[ex.risk],
    description: lines.join("\n").slice(0, 4000),
    author: { name: commit.author.name, icon_url: p.sender.avatar_url },
    fields: [
      {
        name: "Changes",
        value: `+${commit.added.length} added · ~${commit.modified.length} modified · −${commit.removed.length} removed`,
        inline: true,
      },
      { name: "Commit", value: `\`${commit.id.slice(0, 7)}\``, inline: true },
    ],
    footer: { text: `${p.repository.full_name} · ${branch}` },
    timestamp: commit.timestamp,
  };
}

async function postToDiscord(embeds: unknown[]): Promise<void> {
  // Discord caps at 10 embeds per message
  for (let i = 0; i < embeds.length; i += 10) {
    await postWithRetry({ embeds: embeds.slice(i, i + 10) });
  }
}

async function postWithRetry(body: unknown, attempt = 0): Promise<void> {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429 && attempt < 3) {
    const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
    await sleep((info.retry_after ?? 1) * 1000);
    return postWithRetry(body, attempt + 1);
  }

  if (!res.ok) console.error(`discord ${res.status}: ${await res.text()}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
