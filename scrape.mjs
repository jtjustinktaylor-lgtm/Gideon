#!/usr/bin/env node
/**
 * GitHub Radar — daily GitHub intelligence scraper (zero dependencies, Node 18+)
 *
 * Collects:
 *   1. Releases + fresh commits on watched repos
 *   2. Brand-new repos in watched orgs/accounts
 *   3. Brand-new repos matching watched keywords
 *   4. Fresh apps & tools (topic hunts for installable things)
 *   5. Show HN launches (new products from outside GitHub)
 *   6. GitHub Trending (daily)
 *
 * Writes: out/digest-YYYY-MM-DD.md · out/latest.md · out/latest.json
 *
 * Usage:
 *   node scrape.mjs          incremental digest (only items not seen before)
 *   node scrape.mjs --full   ignore seen-state, report everything found
 *   node scrape.mjs --json   print the JSON report to stdout
 *
 * Auth (optional): export GITHUB_TOKEN=... raises the API rate limit
 * from 60/h to 5000/h. NEVER commit a token.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'out');
const STATE = path.join(ROOT, 'state.json');
const CONFIG = path.join(ROOT, 'config.json');
const UA = 'github-radar/1.2 (github.com/jtjustinktaylor-lgtm/Gideon)';

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const AS_JSON = args.has('--json');

const DEFAULTS = {
  trackedRepos: [
    // LayerX-Network was absorbed into Paxeer-X-Network — the old name now just
    // redirects there and double-listed every release/commit. Track canonical names only.
    'Sidiora-Labs/Paxeer-X-Network',
    'Sidiora-Labs/centra-gideon-agent',
    'decolua/9router',
  ],
  trackedOrgs: ['Sidiora-Labs'],
  keywords: ['paxeer', 'layerx', '402lxp', 'sidiora'],
  // Topic hunts for fresh installable apps/tools (the new-apps finder).
  discover: ['topic:ai-agent', 'topic:mcp-server', 'topic:telegram-bot', 'topic:pwa', 'topic:web-scraping', 'topic:automation'],
  showHN: true,
  trending: ['overall', 'typescript'],
  lookbackDays: 2,
  maxPerSection: 15,
};

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const load = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

async function gh(route) {
  const res = await fetch(`https://api.github.com${route}`, { headers: HEADERS });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
    throw new Error(`rate limited${reset ? `, resets ${new Date(reset * 1000).toISOString()}` : ''}`);
  }
  if (!res.ok) throw new Error(`GET ${route} -> HTTP ${res.status}`);
  return res.json();
}

/** Releases + commits on every watched repo. */
async function watchRepos(cfg, errs) {
  const items = [];
  for (const repo of cfg.trackedRepos) {
    try {
      for (const r of await gh(`/repos/${repo}/releases?per_page=8`)) {
        items.push({
          id: `rel:${repo}/${r.id}`, section: 'releases', repo,
          title: r.name || r.tag_name, url: r.html_url, when: r.published_at,
          note: (r.body || '').trim().split('\n')[0].slice(0, 160),
        });
      }
    } catch (e) { errs.push(`releases · ${repo}: ${e.message}`); }
    try {
      for (const c of await gh(`/repos/${repo}/commits?per_page=8`)) {
        items.push({
          id: `cmt:${repo}/${c.sha}`, section: 'commits', repo,
          title: (c.commit?.message || c.sha).split('\n')[0].slice(0, 120),
          url: c.html_url, when: c.commit?.author?.date,
          note: c.commit?.author?.name || c.author?.login || '',
        });
      }
    } catch (e) { errs.push(`commits · ${repo}: ${e.message}`); }
  }
  return items;
}

/** New repos in watched orgs/accounts + new repos matching watched keywords. */
async function newRepos(cfg, errs) {
  const items = [];
  const push = (r, via) => items.push({
    id: `repo:${r.full_name}`, section: 'new-repos', repo: r.full_name,
    title: r.description || '(no description)', url: r.html_url, when: r.created_at,
    note: `${r.language || '—'} · \u2605${r.stargazers_count}${via ? ` · via ${via}` : ''}`,
  });

  for (const org of cfg.trackedOrgs) {
    let list = null;
    try { list = await gh(`/orgs/${org}/repos?sort=created&direction=desc&per_page=10`); }
    catch {
      try { list = await gh(`/users/${org}/repos?sort=created&direction=desc&per_page=10`); }
      catch (e) { errs.push(`new repos · ${org}: ${e.message}`); }
    }
    for (const r of list || []) push(r, `@${org}`);
  }

  const since = new Date(Date.now() - cfg.lookbackDays * 864e5).toISOString().slice(0, 10);
  for (const kw of cfg.keywords) {
    try {
      const q = encodeURIComponent(`${kw} in:name,description created:>=${since}`);
      const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${cfg.maxPerSection}`);
      for (const r of data.items || []) push(r, `"${kw}"`);
    } catch (e) { errs.push(`keyword "${kw}": ${e.message}`); }
  }
  return items;
}

/** GitHub Trending page scrape (no API for this — parse the HTML). */
async function trending(cfg, errs) {
  const items = [];
  for (const lang of cfg.trending) {
    const suffix = lang === 'overall' ? '' : `/${encodeURIComponent(lang)}`;
    try {
      const res = await fetch(`https://github.com/trending${suffix}?since=daily`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      for (const blk of html.split('<article').slice(1)) {
        const name = (blk.match(/href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/) || [])[1];
        if (!name) continue;
        const today = (blk.match(/<strong>([\d,]+)<\/strong>\s*stars\s+today/) || [])[1] || '';
        const langName = (blk.match(/itemprop="programmingLanguage">([^<]+)</) || [])[1] || lang;
        items.push({
          id: `trend:${name}`, section: 'trending', repo: name, title: name,
          url: `https://github.com/${name}`, when: null,
          note: `${langName}${today ? ` · +${today} \u2605 today` : ''}`,
        });
      }
    } catch (e) { errs.push(`trending · ${lang}: ${e.message}`); }
  }
  return items;
}

/** Fresh APPS & TOOLS: brand-new repos that look installable, found via topic hunts. */
async function appDiscovery(cfg, errs) {
  const items = [];
  const since = new Date(Date.now() - cfg.lookbackDays * 864e5).toISOString().slice(0, 10);
  for (const topic of cfg.discover) {
    try {
      const q = encodeURIComponent(`${topic} created:>=${since} fork:false`);
      const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`);
      for (const r of data.items || []) {
        if (!r.description || r.stargazers_count < 1) continue; // must look like a real, usable thing
        items.push({
          id: `app:${r.full_name}`, section: 'apps', repo: r.full_name,
          title: r.description.trim().slice(0, 120), url: r.html_url, when: r.created_at,
          note: `${r.language || '\u2014'} \u00b7 \u2605${r.stargazers_count} \u00b7 ${topic.replace('topic:', '#')}`,
        });
      }
    } catch (e) { errs.push(`apps \u00b7 ${topic}: ${e.message}`); }
  }
  return items;
}

/** Show HN \u2014 brand-new products launching outside GitHub (Algolia HN API, no key needed). */
async function showHN(cfg, errs) {
  if (cfg.showHN === false) return [];
  const items = [];
  const since = Math.floor((Date.now() - cfg.lookbackDays * 864e5) / 1000);
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&numericFilters=created_at_i%3E=${since}&hitsPerPage=15`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const h of data.hits || []) {
      items.push({
        id: `hn:${h.objectID}`, section: 'showhn', repo: `Show HN #${h.objectID}`,
        title: (h.title || '').slice(0, 120),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        when: h.created_at,
        note: `${h.points || 0} pts \u00b7 ${h.num_comments || 0} comments`,
      });
    }
  } catch (e) { errs.push(`show-hn: ${e.message}`); }
  return items;
}

const SECTIONS = [
  ['releases', '\ud83d\ude80 Releases'],
  ['commits', '\ud83d\udd28 Fresh commits'],
  ['new-repos', '\ud83c\udd95 New repos on the radar'],
  ['apps', '🧰 Fresh apps & tools'],
  ['showhn', '📣 Show HN launches'],
  ['trending', '\ud83d\udc8c GitHub Trending (daily)'],
];

function render(rep) {
  const L = [
    `# GitHub Radar \u2014 ${rep.date}`, '',
    `_${rep.newCount} new item(s) since last run \u00b7 generated ${rep.generated}_`, '',
  ];
  for (const [key, label] of SECTIONS) {
    L.push(`## ${label}`, '');
    const rows = rep[key] || [];
    if (!rows.length) { L.push('_Nothing new._', ''); continue; }
    for (const it of rows) {
      L.push(`- **[${it.title || it.repo}](${it.url})** \`${it.repo}\`${it.note ? ` \u2014 ${it.note}` : ''}${it.when ? ` \u00b7 ${String(it.when).slice(0, 10)}` : ''}`);
    }
    L.push('');
  }
  if (rep.errors.length) {
    L.push('## \u26a0\ufe0f Sources that failed', '');
    for (const e of rep.errors) L.push(`- ${e}`);
    L.push('');
  }
  L.push('---', '_github-radar v1.2 \u00b7 zero-dependency Node scraper_');
  return L.join('\n');
}

async function main() {
  const cfg = { ...DEFAULTS, ...(await load(CONFIG, {})) };
  const prev = FULL ? { seen: {} } : await load(STATE, { seen: {} });
  const errs = [];

  const [rel, nw, ap, hn, tr] = await Promise.all([watchRepos(cfg, errs), newRepos(cfg, errs), appDiscovery(cfg, errs), showHN(cfg, errs), trending(cfg, errs)]);
  // Dedupe before reporting: the same repo surfaces via several keywords ("paxeer"/
  // "layerx"/"sidiora"), and a renamed repo (LayerX-Network -> Paxeer-X-Network)
  // answers under BOTH names with identical URLs. Keep the first hit per id and per URL.
  const uniqIds = new Set(), uniqUrls = new Set(), all = [];
  for (const it of [...rel, ...nw, ...ap, ...hn, ...tr]) {
    if (uniqIds.has(it.id) || (it.url && uniqUrls.has(it.url))) continue;
    uniqIds.add(it.id);
    if (it.url) uniqUrls.add(it.url);
    all.push(it);
  }
  const fresh = all.filter((i) => !prev.seen[i.id]);

  const bucket = {};
  for (const it of fresh.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))) {
    (bucket[it.section] ||= []).push(it);
  }
  for (const [key] of SECTIONS) bucket[key] = (bucket[key] || []).slice(0, cfg.maxPerSection);

  const now = new Date();
  const rep = {
    date: now.toISOString().slice(0, 10),
    generated: now.toISOString(),
    newCount: fresh.length,
    errors: errs,
    ...Object.fromEntries(SECTIONS.map(([key]) => [key, bucket[key] || []])),
  };

  // Persist seen-state (pruned to 14 days) so the daily run only reports news.
  const seen = {};
  const cutoff = Date.now() - 14 * 864e5;
  for (const it of all) seen[it.id] = now.toISOString();
  for (const [k, v] of Object.entries(prev.seen || {})) {
    if (!seen[k] && Date.parse(v) > cutoff) seen[k] = v;
  }
  await writeFile(STATE, JSON.stringify({ lastRun: now.toISOString(), seen }, null, 2));

  // Gideon App Store shelf \u2014 every discovered app is catalogued here permanently.
  const storePath = path.join(ROOT, 'docs', 'store.json');
  const store = await load(storePath, { apps: [] });
  const known = new Set((store.apps || []).map((a) => a.id));
  for (const it of all.filter((i2) => i2.section === 'apps')) {
    if (known.has(it.id)) continue;
    known.add(it.id);
    store.apps.push({
      id: it.id, name: it.repo.split('/')[1], repo: it.repo,
      desc: it.title, url: it.url, when: it.when, note: it.note,
    });
  }
  store.updated = now.toISOString();
  store.apps = (store.apps || [])
    .sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))
    .slice(0, 200);

  const md = render(rep);
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, `digest-${rep.date}.md`), md);
  await writeFile(path.join(OUT, 'latest.md'), md);
  await writeFile(path.join(OUT, 'latest.json'), JSON.stringify(rep, null, 2));

  // Public site feed — served by GitHub Pages from /docs (see docs/index.html)
  const SITE = path.join(ROOT, 'docs');
  await mkdir(SITE, { recursive: true });
  await writeFile(path.join(SITE, 'LATEST.md'), md);
  await writeFile(path.join(SITE, 'data.json'), JSON.stringify(rep, null, 2));
  await writeFile(path.join(ROOT, 'docs', 'store.json'), JSON.stringify(store, null, 2));

  if (AS_JSON) console.log(JSON.stringify(rep, null, 2));
  else console.log(md);
  if (errs.length) console.error(`[github-radar] ${errs.length} source(s) failed \u2014 listed in the digest.`);
}

main().catch((e) => { console.error(`[github-radar] fatal: ${e.message}`); process.exit(1); });
