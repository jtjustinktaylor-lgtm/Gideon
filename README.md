# 📡 GitHub Radar

**Daily GitHub intelligence scraper.** Zero dependencies, one file, runs anywhere Node 18+ exists. Every day it scrapes GitHub and hands you a digest of what actually moved:

| Section | Source |
|---|---|
| 🚀 Releases | `releases` endpoint of every watched repo |
| 🔨 Fresh commits | `commits` endpoint of every watched repo |
| 🆕 New repos | watched orgs/accounts + keyword search (newest first) |
| 📈 Trending | `github.com/trending` daily page (overall + per-language) |

Incremental by default: a `state.json` remembers what you've already seen, so each run reports **only the news**. Everything is configurable in `config.json`.

## Quick start

```bash
node scrape.mjs          # incremental digest -> out/latest.md
node scrape.mjs --full   # ignore state, report everything
node scrape.mjs --json   # machine-readable report on stdout
```

Optional (raises the GitHub API rate limit 60/h → 5000/h — never commit this):

```bash
export GITHUB_TOKEN=ghp_xxx
```

## Configure

`config.json`:

```json
{
  "trackedRepos":  ["Sidiora-Labs/LayerX-Network", "decolua/9router"],
  "trackedOrgs":   ["Sidiora-Labs"],
  "keywords":      ["paxeer", "layerx", "402lxp", "sidiora"],
  "trending":      ["overall", "typescript"],
  "lookbackDays":  2,
  "maxPerSection": 15
}
```

## Output

- `out/digest-YYYY-MM-DD.md` — dated markdown digest
- `out/latest.md` — newest digest (what automations deliver)
- `out/latest.json` — the same report, machine-readable
- `state.json` — seen-items ledger (auto-pruned past 14 days)

## Runs daily inside Gideon

This repo ships as a Gideon app: a scheduled automation runs `node scrape.mjs`
once a day and delivers `out/latest.md`. Gideon has no public app store — apps
install as **skills + automations**, which is exactly how this one is wired.

## Notes

- Trending has no official API; it is scraped from the public HTML page and
  parsed defensively (a layout change degrades that section, never the run).
- Per-item failures are collected into a `⚠️ Sources that failed` section —
  the digest always produces.
- Scrapes only public GitHub data at a modest daily volume. Be a good citizen:
  keep it to a daily cadence.

MIT © 2026 Justin Taylor — see `LICENSE`.
