/**
 * Runs the full pipeline against stubbed GitHub / Gemini / Discord endpoints.
 *
 *   npx tsx test/smoke.ts
 *
 * No network calls and no real API keys required.
 */
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
process.env.GEMINI_API_KEY = "test-key";
process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";

const SECRET = "testsecret";

const posted: any[] = [];
const geminiRequests: any[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);

  if (u.includes("api.github.com")) {
    return new Response(
      `diff --git a/package-lock.json b/package-lock.json\n+noise\n` +
        `diff --git a/src/auth.ts b/src/auth.ts\n@@\n` +
        `-  verify(token)\n+  verifyStrict(token, { clockSkew: 30 })\n`,
      { status: 200 },
    );
  }

  if (u.includes("generativelanguage.googleapis.com")) {
    geminiRequests.push({ url: u, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "let me look at this diff", thought: true },
                {
                  text: JSON.stringify({
                    headline: "Tightens JWT verification with clock-skew bounds",
                    bullets: [
                      "verify() swapped for verifyStrict() in src/auth.ts",
                      "Adds a 30s clock skew allowance, so slightly-early tokens now pass",
                    ],
                    risk: "high",
                    risk_note: "Touches token validation on every authenticated request.",
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 812,
          candidatesTokenCount: 96,
          thoughtsTokenCount: 141,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (u.includes("discord.test")) {
    posted.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  }

  return realFetch(url, init);
}) as any;

const { default: handler, processPush } = await import("../api/github-webhook.ts");

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const payload = {
  ref: "refs/heads/main",
  deleted: false,
  forced: false,
  compare: "https://github.com/example-org/example-repo/compare/aaaaaaa...bbbbbbb",
  commits: [
    {
      id: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
      message: "fix(auth): harden token check",
      url: "https://github.com/example-org/example-repo/commit/b1c2d3e",
      timestamp: "2026-01-01T12:00:00Z",
      author: { name: "Example Dev", username: "example-dev" },
      added: [],
      modified: ["src/auth.ts"],
      removed: [],
    },
  ],
  head_commit: null,
  repository: {
    full_name: "example-org/example-repo",
    html_url: "https://github.com/example-org/example-repo",
    private: true,
  },
  pusher: { name: "example-dev" },
  sender: { login: "example-dev", avatar_url: "https://avatars.test/1" },
};

const body = JSON.stringify(payload);
const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");

/* ------------------------------------------------------------------ */
/* minimal node req/res doubles                                        */
/* ------------------------------------------------------------------ */

function mockReq(headers: Record<string, string>, reqBody: string, method = "POST") {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(reqBody);
    },
  } as any;
}

function mockRes() {
  const res: any = { statusCode: 0, body: "" };
  res.end = (chunk?: unknown) => {
    res.body = chunk == null ? "" : String(chunk);
  };
  return res;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function call(headers: Record<string, string>, method = "POST") {
  const res = mockRes();
  await handler(mockReq(headers, body, method), res);
  return res;
}

/* ------------------------------------------------------------------ */
/* handler contract                                                    */
/* ------------------------------------------------------------------ */

const bad = await call({ "x-github-event": "push", "x-hub-signature-256": "sha256=deadbeef" });
check("bad signature rejected", bad.statusCode === 401, `got ${bad.statusCode}`);

const ping = await call({ "x-github-event": "ping", "x-hub-signature-256": sig });
check("ping answered", ping.statusCode === 200 && ping.body === "pong", ping.body);

const other = await call({ "x-github-event": "issues", "x-hub-signature-256": sig });
check("non-push event ignored", other.statusCode === 200 && other.body === "ignored");

const get = await call({ "x-github-event": "push", "x-hub-signature-256": sig }, "GET");
check("non-POST rejected", get.statusCode === 405, `got ${get.statusCode}`);

const ok = await call({ "x-github-event": "push", "x-hub-signature-256": sig });
check("push acked fast", ok.statusCode === 202, `got ${ok.statusCode}`);

/* ------------------------------------------------------------------ */
/* background pipeline                                                 */
/* ------------------------------------------------------------------ */

// The handler hands the pipeline to waitUntil(), which there is no way to await
// from here, so drive it directly and ignore whatever the calls above captured.
posted.length = 0;
geminiRequests.length = 0;
await processPush(payload as any);

const embed = posted[0]?.embeds?.[0];
const gemini = geminiRequests[0];
const prompt = gemini?.body?.contents?.[0]?.parts?.[0]?.text ?? "";
const gc = gemini?.body?.generationConfig ?? {};

check("discord received one embed", !!embed);
check("headline in embed", !!embed?.description?.includes("clock-skew"));
check("risk color is red", embed?.color === 0xf85149, String(embed?.color));
check("risk note rendered", !!embed?.description?.includes("HIGH RISK"));
check("lockfile stripped from diff", !prompt.includes("package-lock"));
check("thought part excluded from output", !embed?.description?.includes("let me look"));
check("systemInstruction sent", !!gemini?.body?.systemInstruction);
check("responseSchema sent", !!gc.responseSchema && gc.responseMimeType === "application/json");
check(
  "thinking fields mutually exclusive",
  !("thinkingLevel" in (gc.thinkingConfig ?? {}) && "thinkingBudget" in (gc.thinkingConfig ?? {})),
  JSON.stringify(gc.thinkingConfig),
);

console.log("\n--- discord payload ---");
console.log(JSON.stringify(posted[0], null, 2));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
