/**
 * Runs the full pipeline against stubbed GitHub / Anthropic / Discord endpoints.
 *
 *   npx tsx test/smoke.ts
 *
 * No network calls and no real API keys required.
 */
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";

const SECRET = "testsecret";

const posted: any[] = [];
const claudeRequests: any[] = [];
let claudeRefuses = false;
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

  if (u.includes("api.anthropic.com")) {
    claudeRequests.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    if (claudeRefuses) {
      return new Response(
        JSON.stringify({ stop_reason: "refusal", content: [{ type: "text", text: "I can't help with that." }] }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "let me look at this diff", signature: "x" },
          {
            type: "text",
            text: JSON.stringify({
              headline: "Tightens JWT verification with clock-skew bounds",
              bullets: [
                "verify() swapped for verifyStrict() in src/auth.ts",
                "Adds a 30s clock skew allowance, so slightly-early tokens now pass",
              ],
              risk: "High",
              risk_note: "Touches token validation on every authenticated request.",
            }),
          },
        ],
        usage: { input_tokens: 812, output_tokens: 96 },
      }),
      { status: 200 },
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
claudeRequests.length = 0;
await processPush(payload as any);

const embed = posted[0]?.embeds?.[0];
const claude = claudeRequests[0];
const prompt = claude?.body?.messages?.[0]?.content ?? "";
const oc = claude?.body?.output_config ?? {};

check("discord received one embed", !!embed);
check("headline in embed", !!embed?.description?.includes("clock-skew"));
check("risk color is red (mixed-case enum normalized)", embed?.color === 0xf85149, String(embed?.color));
check("risk note rendered", !!embed?.description?.includes("HIGH RISK"));
check("lockfile stripped from diff", !prompt.includes("package-lock"));
check("thinking block excluded from output", !embed?.description?.includes("let me look"));
check("haiku model requested", claude?.body?.model === "claude-haiku-5-5", claude?.body?.model);
check("system prompt sent", typeof claude?.body?.system === "string" && claude.body.system.length > 0);
check("api key + version headers", claude?.headers?.["x-api-key"] === "test-key" && !!claude?.headers?.["anthropic-version"]);
check(
  "json schema sent",
  oc.format?.type === "json_schema" && oc.format?.schema?.additionalProperties === false,
);
check("no temperature sent", !("temperature" in (claude?.body ?? {})));

// a refusal must fall back to the raw commit message, not post the refusal text
const firstPayload = posted[0];
posted.length = 0;
claudeRefuses = true;
await processPush(payload as any);
claudeRefuses = false;
const refused = posted[0]?.embeds?.[0];
check("refusal falls back to commit message", !!refused?.description?.includes("harden token check") && !refused?.description?.includes("can't help"));
posted.length = 0;
posted.push(firstPayload);

console.log("\n--- discord payload ---");
console.log(JSON.stringify(posted[0], null, 2));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
