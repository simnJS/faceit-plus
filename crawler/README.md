# FACEIT crawler

Standalone tool that builds a database of vetos, meant to train a map
prediction model finer than the extension's current heuristic.

No dependencies: Node 22+ is enough (SQLite is built in).

## API key

The crawler uses the **official API** to discover players and matches. A free
key is obtained at [developers.faceit.com](https://developers.faceit.com):
create an application, then generate a "server side" key.

Since the ban sequence isn't exposed by the official API, it is read from the
public veto endpoint — no key required, but subject to the same rate limiter.

## Usage

Copy `.env.example` to `.env` at the repo root and fill in the key, then:

```bash
npm run crawl
```

The `.env` file is loaded automatically (`FACEIT_API_KEY` and `FACEIT_SEED`)
and is excluded from the repo. Options go after `--`:

```bash
npm run crawl -- --max-matches 50000 --rps 3
```

The crawl works as a **snowball**: it starts from the seed, fetches its
matches, then the ten players of each match join the queue. Coverage extends
itself naturally to every elo bracket.

Useful options:

| Option | Role |
| --- | --- |
| `--seed <nickname>` | starting point, repeatable (unnecessary once the database is seeded) |
| `--max-matches <n>` | stop after adding n matches |
| `--max-depth <n>` | limit how far to stray from the seeds |
| `--per-player <n>` | matches fetched per player (max 100) |
| `--rps <n>` | cap on the official API, 22 by default |
| `--veto-rps <n>` | cap on the veto endpoint, 35 by default |
| `--concurrency <n>` | matches processed in parallel, 10 by default |

### Rate limit

The official API **announces its limit in its response headers**:

```
ratelimit-limit: 20, 20;w=1
ratelimit-remaining: 16
```

That is **20 requests per second**, on a sliding one-second window — not an
hourly quota. The crawler sets itself to 18 to keep a margin. Going higher is
pointless: 429s start showing up and the backoff pauses cancel out the gain
(measured: 17 matches/s with 10 rejections at 28 req/s, versus 16.5 with zero
rejections).

The veto endpoint is more permissive (no rejection observed up to 60 req/s),
hence the two separate limiters.

In practice: **~16 matches/second**, or close to 60,000 per hour. Expect
about 3h30 for 200,000 matches. Throughput does drop with depth, though, as
the crawler increasingly runs into matches it already knows.

To go further, the intended path is to **ask FACEIT support for a quota
increase**, explaining the use case — not multiplying API keys, which would
amount to working around the announced limit.

## Monitoring

```bash
npm run crawl:stats
```

The crawl is **resumable**: the state lives in the database, so rerunning the
command picks up where it left off. `Ctrl+C` cleanly finishes the current
player.

## Player countries

A match's roster does not include country data: it takes one request per
player, done separately so it doesn't slow down the crawl, and only once per
player.

```bash
npm run crawl:enrich -- --limit 2000
```

Country data is mainly used to describe the **lobby composition** (number of
nationalities, size of the largest common bloc), which is a signal for a
team's degree of coordination — far more telling than nationality taken in
isolation.

## Training set

```bash
node crawler/export.mjs --out crawler/dataset.jsonl
```

Produces **one line per ban decision**: the veto state before the decision
(remaining maps, turn number, side and captain who is banning, both teams'
average elo and level, region, date) and the map actually banned, which is
the target to predict.

This is the format suited to a policy model: we learn to predict *the next
ban*, then roll the model forward in the Monte Carlo simulation already
present in the extension to obtain the final map.

## Volume

A veto is roughly six lines. A few tens of thousands of matches are plenty to
train a seven-class model — the useful order of magnitude is tens of
thousands, not millions.

## Good conduct

A single IP address, a moderate rate, no proxy rotation or protection
bypass: `--rps 3` stays well under the limits and bothers no one. If a `429`
occurs, the client waits and retries on its own. There's no point going
faster: the limiting factor is the total volume to collect once, not the
instantaneous rate.
