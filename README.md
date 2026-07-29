# commit-explainer

Every time someone pushes to GitHub, this reads the actual diff of each commit, has Gemini explain what changed in plain English, and posts that to a Discord channel as an embed with a risk rating attached.

```
GitHub push --> /api/github-webhook --> 202 ack (immediately)
                        |
                        +-- background: fetch diff --> Gemini --> Discord embed
```

It is one Vercel serverless function. There is no database, no queue, and no state to manage.

## Why I built it

GitHub's own Discord integration already posts commit messages to a channel. The problem is that a commit message is written by the person who already knows what the change does, so it is usually the least informative description of it. `fix(auth): harden token check` does not tell you whether you should go look at it.

This reads the diff instead. It tells you what the code now does, names the functions and files that moved, and flags the commit as low, medium, or high risk so you know which ones are worth opening. The risk rating is the actual point. A feed you can skim is only useful if it tells you when to stop skimming.

## What a message looks like

Each commit gets one embed:

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

## Why the 202

GitHub marks a delivery failed if you do not respond in about 10 seconds. A push with 5 commits means 5 diff fetches plus 5 LLM calls, which will blow straight through that. So the handler verifies the signature, acks with 202 immediately, and finishes the real work in `waitUntil()`.

Two things in `api/github-webhook.ts` that look like style choices but are not:

1. `bodyParser` is off. The HMAC is computed over the exact bytes GitHub sent, so anything that parses and re-serializes the body first breaks signature verification.
2. The handler is `(req, res)`, not a Web-style handler that returns a `Response`. Vercel's Node runtime invokes it as `(req, res)`, so returning a `Response` object means `res` never gets written, the request hangs until `maxDuration`, and the build still reports green. That failure mode is silent and annoying to find.

## What it skips on purpose

Every one of these exists to keep the token bill down.

- Tag pushes and branch deletions. Nothing runs.
- Merge commits, unless you set `SKIP_MERGE_COMMITS=false`.
- Any branch not in `BRANCH_FILTER`, if you set one. Empty means every branch.
- Lockfiles, `.min.js`, `.min.css`, `dist/`, and `build/` hunks. These are stripped out of the diff before it is ever counted. On a typical JS repo this is the single biggest saving.
- Everything past the newest `MAX_COMMITS_PER_PUSH` commits. A 40 commit push does not need 40 LLM calls, so the newest few get full explanations and the rest get rolled into one line with a link to the compare view.
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
- **Events:** Just the push event

For private repos you also need `GITHUB_TOKEN`, a fine-grained PAT with `Contents: Read-only` on the repos you care about. Without it the diff fetch 404s and you get message-only summaries, which defeats the whole point.

## Cost and model choice

Default is `gemini-3.6-flash` at $1.50 input / $7.50 output per million tokens. With `MAX_DIFF_CHARS=12000` a commit runs roughly 3k input plus 100 output plus 150 thinking tokens, so about **$0.006 per commit**.

The Flash ladder, cheapest first:

| Model | Input / Output per MTok | Notes |
|---|---|---|
| `gemini-2.5-flash-lite` | $0.10 / $0.40 | Absolute floor, but Google retires it 16 Oct 2026 |
| `gemini-3.1-flash-lite` | $0.25 / $1.50 | The cheap option worth actually building on |
| `gemini-3-flash` | $0.50 / $3.00 | Middle ground |
| `gemini-3.6-flash` | $1.50 / $7.50 | Default here, launched 21 Jul 2026 |

Summarizing a commit is squarely a Flash-Lite task. `gemini-3.1-flash-lite` costs a sixth of the default and will produce near-identical output on this prompt, so set `MODEL=gemini-3.1-flash-lite` unless you find the summaries thin.

**Thinking tokens bill at output rates.** This is the line item that surprises people. Gemini 3.x thinks by default and those tokens land on the output meter, which is why `THINKING_LEVEL=low` and `MAX_TOKENS=1200` are the defaults. Set `MAX_TOKENS` too low and the model burns the whole budget thinking, then returns `finishReason: MAX_TOKENS` with an empty parts array and you get a fallback message with no error to explain it. The handler logs `thoughts=` on every call so you can watch the real ratio instead of guessing.

Other levers: lower `MAX_DIFF_CHARS`, set `BRANCH_FILTER=main` so feature-branch churn never reaches the API, or drop `MAX_COMMITS_PER_PUSH` to 3.

## Free tier warning

Gemini's Flash models have a standing free tier and it is tempting. Content sent on the free tier is used to improve Google's products. Do not point this at a private repo on a free-tier key. Enable billing on the project so requests bill against the paid tier before you connect anything proprietary. Worth noting.

## Configuration

All of it is environment variables, documented in `.env.example`. Required: `GITHUB_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`. Required for private repos: `GITHUB_TOKEN`. Everything else is tuning and has a sane default.

## Test locally

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs the whole pipeline against stubbed GitHub, Gemini, and Discord endpoints. No network calls and no real API keys, so it is safe to run anywhere. It checks the handler contract (bad signature, ping, non-push events, non-POST, fast ack) and then drives the background half directly and asserts on what actually reached Discord.

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

The prompt lives in `SYSTEM_PROMPT`. The JSON shape is enforced server-side by `responseSchema` with `responseMimeType: "application/json"`, so there is no fence-stripping or parse-retry logic to maintain.

The risk rubric is the part worth editing first, since what counts as high risk is specific to your codebase. Right now it treats auth, secrets, permissions, data deletion, schema migrations, and infra changes as high. If you want a role ping on high risk commits, add `content: "<@&ROLE_ID>"` alongside `embeds` in `postToDiscord` when any embed in the batch came back high.

Two Gemini-specific details in `explainCommit` worth not breaking:

- `thinkingLevel` (Gemini 3.x) and `thinkingBudget` (2.5 and earlier) cannot both be sent. Doing so is a 400. `thinkingConfig()` picks one based on the model name, so changing `MODEL` across generations does not need a code edit.
- `safetySettings` are set to `BLOCK_NONE` on all four categories. Diffs touching auth, exploit handling, or anything that reads as violent out of context otherwise come back as an empty candidate with no useful error.

## Failure behavior

Every failure mode degrades instead of dropping the event.

- Bad signature: 401, nothing runs.
- Diff fetch fails: empty diff, and the model summarizes from the commit message alone and says so in a bullet.
- Gemini errors, blocks the prompt, or returns an empty candidate: falls back to the raw commit message.
- Discord 429: retries up to 3 times honoring `retry_after`.
- More than 10 embeds: Discord caps a message at 10, so they go out in batches.

Errors go to `console.error` and show up in Vercel's function logs.

## License

MIT. See `LICENSE`.
