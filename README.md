# FACEIT+

Browser extension that enriches FACEIT (CS2) match rooms, on Chrome and Firefox.

## Features

**In the match room**

- **Country flags** next to each nickname.
- **CS2 Premier rank** displayed before the FACEIT level, in the tier's official colors.
- **K/D per map** under each player, matched to the match's map pool: only the
  picked map is shown once the veto is over, and a button expands the full pool.
- **Estimated role** (sniper, entry, support, clutcher, anchor, carry, rifler) with
  the score breakdown on hover.

**During the veto**

- **Winrate of both teams** on each map, aggregated from the players' recent history.
- **Ban probability** of each map, computed from the enemy captain's veto history.
- **Which map to ban**, recommended by a model trained on tens of thousands of
  real vetos: for every possible ban, it plays out the rest of the veto and
  keeps the option that maximizes the expected advantage on the final map. The
  recommendation is recomputed on every turn.
- **Most likely final map**, computed exactly rather than estimated.
- Banned tiles are dimmed as the rounds go by.

**Automation** (disabled by default)

- **Auto-accept** the match, with an adjustable delay and the option to cancel.
- **Auto-ban maps** when you are captain, either following a preferred order
  or by banning the map where your team has the worst winrate.

**Settings** — a panel accessible from the badge in the bottom-right corner of FACEIT
lets you toggle each feature and choose the language (French / English).

## Development

```bash
npm install
npm run dev          # Chrome
npm run dev:firefox  # Firefox
```

Then load `.output/chrome-mv3-dev` via `chrome://extensions` in developer mode
("Load unpacked"). Code changes are then applied automatically; only manifest
changes require a manual reload.

```bash
npm run compile      # TypeScript check
npm run build        # Chrome production build
npm run build:firefox
npm run zip          # store-ready archive
```

## The veto model

The weights are trained offline (see [`crawler/`](crawler/)) and then **bundled
into the extension** — a few kilobytes. No server, no latency, no data leaves
the browser: the prediction runs entirely on your machine.

Measured on matches after the training cutoff, never seen before:

| | model | best simple rule | random |
| --- | --- | --- | --- |
| next ban | ~55% | ~33% | ~27% |
| map actually played | ~34% | ~26% | ~15% |

The split is temporal and in three sets: training, validation for picking the
epoch, and a test set consulted only once — otherwise the published number
would be the best of twenty rolls rather than an honest measurement.

## Data sources

The extension relies on FACEIT's internal APIs (the same requests the site
makes, using your session cookies) for profiles, history, and veto. The
Premier rank, absent from FACEIT, comes from csstats.gg with Leetify as a
fallback. No data is sent to any third-party server: all computations happen
in the browser and are cached locally.

## Tech stack

[WXT](https://wxt.dev) (Manifest V3, builds Chrome and Firefox from a single
codebase), TypeScript, and React.
