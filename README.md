# commit-explainer

Github Webhook to summarize commits in laymen terms and automatically push to a discord channel. Great for updating non-technical or semi-technical shareholders.

```
GitHub push --> /api/github-webhook --> 202 ack (immediately)
                        |
                        +-- background: fetch diff --> Claude Haiku --> Discord embed
```

It is one Vercel serverless function. There is no database, no queue, and no state to manage.

## Why I built it

GitHub's own Discord integration already posts commit messages to a channel. The problem is that a commit message is written by the person who already knows what the change does, so it is usually the least informative description of it. `fix(auth): harden token check` does not tell you whether you should go look at it.

This reads the diff instead. It tells you what the code now does, names the functions and files that moved, and flags the commit as low, medium, or high risk in terms of breaking changes.

## What a message looks like

Message composition:

- A headline in plain English, capped at 90 characters, that does not just restate the commit message.
- Two to four bullets that name the real functions, files, endpoints, env vars, or queries that changed, and say what the consequence is.
- A risk rating that drives the embed color. Green for low, amber for medium, red for high.
- A risk note on anything medium or high explaining why.
- Footer with the repo, the branch, the short sha, and the added/modified/removed file counts.

Example of the JSON the model returns, which then becomes the embed:

```json
{
  "headline": "Tightens JWT verification with clock-skew bounds",
  "bullets": ["verify() swapped for verifyStrict() in src/auth.ts", "..."],
  "risk": "high",
  "risk_note": "Touches token validation on every authenticated request."
}
```

## 202 Error codes

GitHub marks a delivery failed if you do not respond in about 10 seconds. A push with 5 commits means 5 diff fetches plus 5 LLM calls. The handler verifies the signature, acks with 202 immediately, and finishes in `waitUntil()`.

Two things in `api/github-webhook.ts` to note:

1. `bodyParser` is off. The HMAC is computed over the bytes GitHub sent, so anything that parses and re-serializes the body first breaks signature verification.
2. The handler is `(req, res)`, not a Web-style handler that returns a `Response`. Vercel's Node runtime invokes it as `(req, res)`, so returning a `Response` object means `res` never gets written, the request hangs until `maxDuration`, and the build shows a success.

## What it skips on purpose

Design choices to minimize cost.

- Tag pushes and branch deletions. Nothing runs.
- Merge commits, unless you set `SKIP_MERGE_COMMITS=false`.
- Any branch not in `BRANCH_FILTER`, if you set one. Empty means every branch.
- Lockfiles, `.min.js`, `.min.css`, `dist/`, and `build/` hunks. These are stripped out of the diff before it is ever counted.
- Everything past the newest `MAX_COMMITS_PER_PUSH` commits. A 40 commit push does not need 40 LLM calls, so the newest few get full explanations and the rest get compressed into one line with a link to the compare view.
- Diffs longer than `MAX_DIFF_CHARS` get truncated, and the embed says so.

## Deploy

```bash
npm i -g vercel
vercel link
vercel env add GITHUB_WEBHOOK_SECRET     # repeat for each var in .env.example
vercel deploy --prod
```

## Wire up GitHub

Repo (or org) Settings > Webhooks > Add webhook:

- **Payload URL:** `https://<your-deployment>.vercel.app/api/github-webhook`
- **Content type:** `application/json`
- **Secret:** same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Push event

For private repos you also need `GITHUB_TOKEN`, a fine-grained PAT with `Contents: Read-only`. Without it the diff fetch 404s and you get message-only summaries.

## Cost and model choice

Default is `claude-haiku-5-5` at $0.10 input / $0.50 output per million tokens (for prompts under 100k tokens, which every commit here is). With `MAX_DIFF_CHARS=12000` a commit runs roughly 4k input plus a few hundred output and thinking tokens, so about **$0.0005 per commit**. Haiku's tokenizer counts the same text as roughly 30% more tokens than older Claude models, which is already in that estimate.
This will depend on the size of your commits.

Summarizing a commit is squarely a Haiku task. If you want richer summaries on big diffs, `MODEL=claude-sonnet-5-5` ($2 / $10) works with no code change, at about 20x the cost.

**Thinking tokens bill at output rates.** Haiku thinks adaptively and those tokens land on the output meter and count toward `max_tokens`, which is why `EFFORT=low` and `MAX_TOKENS=1200` are the defaults. Set `MAX_TOKENS` too low and the answer is cut off with `stop_reason: "max_tokens"`, and you get a fallback message. The handler logs `in=`, `out=` and `stop=` on every call so you can watch the real numbers instead of guessing.

Other levers: lower `MAX_DIFF_CHARS`, set `BRANCH_FILTER=main` so feature-branch churn never reaches the API, or drop `MAX_COMMITS_PER_PUSH` to 3.

## Data use

Anthropic does not train on API traffic by default, so pointing this at a private repo is fine on a normal API key. There is no free tier to worry about.

## Configuration

All of it is environment variables, documented in `.env.example`. Required: `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`. Required for private repos: `GITHUB_TOKEN`. Everything else is tuning and has a sane default.

## Test locally

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs the whole pipeline against stubbed GitHub, Anthropic, and Discord endpoints. No network calls and no real API keys, so it is safe to run anywhere. It checks the handler contract (bad signature, ping, non-push events, non-POST, fast ack) and then drives the background half directly and asserts on what actually reached Discord.

`processPush` is exported for that reason. `waitUntil()` is a no-op outside the Vercel runtime, so there is no way to await the background work from a test without it.

To hit a real deployment with a signed payload:

```bash
BODY=$(cat sample-push.json)
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"

curl -X POST https://<your-deployment>.vercel.app/api/github-webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: $SIG" \
  --data-raw "$BODY"
```

Grab a real `sample-push.json` from the Recent Deliveries tab on the GitHub webhook page. That tab is also where you check redelivery and response codes when something looks wrong.

## Tuning the output

The prompt lives in `SYSTEM_PROMPT`. The JSON shape is enforced server-side by structured outputs (`output_config.format` with a JSON schema), so there is no fence-stripping or parse-retry logic to maintain.

The risk rubric is the part worth editing first, since what counts as high risk is specific to your codebase. Right now it treats auth, secrets, permissions, data deletion, schema migrations, and infra changes as high. If you want a role ping on high risk commits, add `content: "<@&ROLE_ID>"` alongside `embeds` in `postToDiscord` when any embed in the batch came back high.

Three Claude-specific details in `explainCommit` worth not breaking:

- No `temperature`. Current Claude models with adaptive thinking reject sampling parameters, so sending one is a 400.
- The schema sets `additionalProperties: false`. Structured outputs require it on every object.
- Enum casing is not guaranteed by structured outputs (`"High"` can come back for `"high"`), so `normalize()` lowercases `risk` before checking it.

## Failure behavior

Every failure mode degrades instead of dropping the event.

- Bad signature: 401, nothing runs.
- Diff fetch fails: empty diff, and the model summarizes from the commit message alone and says so in a bullet.
- Claude errors, refuses, runs out of `max_tokens`, or returns no text: falls back to the raw commit message.
- Discord 429: retries up to 3 times honoring `retry_after`.
- More than 10 embeds: Discord caps a message at 10, so they go out in batches.

Errors go to `console.error` and show up in Vercel's function logs.

## License

MIT. See `LICENSE`.
