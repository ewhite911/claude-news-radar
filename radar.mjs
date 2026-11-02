#!/usr/bin/env node
// 클로드 새 소식 감지 — 공식 소스를 읽어 처음 보는 소식이면 ntfy 로 휴대폰 푸시를 보낸다
// 실행: node radar.mjs  (DRY=1 이면 보내지 않고 화면에만 출력)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(ROOT, 'state', 'seen.json');
const DRY = process.env.DRY === '1';
const TOPIC = process.env.NTFY_TOPIC;
const UA = 'Mozilla/5.0 (claude-news-radar)';
const MAX_PUSH = 8;        // 한 번에 보내는 알림 최대 수 (넘으면 요약 한 통)
const KEEP_IDS = 400;      // 소스마다 기억하는 ID 수
const FAIL_ALERT = 8;      // 연속 실패가 이만큼(15분 × 8 = 2시간)이면 경고 알림

const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function get(url, json = false) {
  const headers = { 'user-agent': UA };
  if (url.startsWith('https://api.github.com') && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return json ? res.json() : res.text();
}

// 목록 페이지: 경로가 prefix 로 시작하는 링크마다 글자를 모아, 제목+설명이 있는 것만 소식으로 본다(분류 링크 제외)
// 링크 안에 <h2~4> 제목과 <p> 설명이 있으면 그것을 쓴다('Article', 날짜 같은 꼬리표 대신)
function parseListing(html, prefix, base) {
  const parts = new Map();
  const heads = new Map();
  for (const m of html.matchAll(new RegExp(`<a[^>]+href="(?:${base.replace(/[.]/g, '\\.')})?(${prefix}[a-z0-9-]+)"[^>]*>([\\s\\S]*?)</a>`, 'g'))) {
    const got = m[2].replace(/<[^>]+>/g, '\n').split('\n').map(text).filter(Boolean);
    parts.set(m[1], [...new Set([...(parts.get(m[1]) ?? []), ...got])]);
    const h = m[2].match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/);
    if (h && !heads.has(m[1])) heads.set(m[1], { title: text(h[1]), detail: text(m[2].match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/)?.[1] ?? '') });
  }
  return [...parts].filter(([path, p]) => heads.has(path) || p.length >= 2)
    .map(([path, p]) => ({ id: path, title: heads.get(path)?.title ?? p[0], detail: heads.get(path)?.detail ?? p[1], url: base + path }));
}

// 릴리스 노트: 'October 21, 2026' 같은 날짜 제목마다 다음 제목 전까지를 한 소식으로
function parseReleaseNotes(html, url) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  // 제목 안에 '링크 복사' 버튼 글자가 붙어 있을 수 있어 앞의 날짜만 쓴다
  const heads = [...body.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map(m => ({ date: text(m[2]).match(/^[A-Z][a-z]+ \d{1,2}, \d{4}\b/)?.[0], at: m.index, end: m.index + m[0].length }))
    .filter(h => h.date);
  return heads.map((h, i) => {
    const chunk = text(body.slice(h.end, heads[i + 1]?.at ?? h.end + 3000));
    return { id: h.date, title: cut(chunk, 90), detail: chunk, url, date: h.date };
  });
}

const SOURCES = [
  { key: 'claude-blog', label: 'Claude 블로그', tags: 'sparkles', priority: 4,
    read: async () => parseListing(await get('https://claude.com/resources/articles'), '/resources/articles/', 'https://claude.com') },
  { key: 'anthropic-news', label: 'Anthropic 소식', tags: 'newspaper', priority: 4,
    read: async () => parseListing(await get('https://www.anthropic.com/news'), '/news/', 'https://www.anthropic.com') },
  { key: 'apps-notes', label: 'Claude 앱 업데이트', tags: 'iphone', priority: 4,
    read: async () => parseReleaseNotes(await get('https://docs.claude.com/en/release-notes/claude-apps'), 'https://docs.claude.com/en/release-notes/claude-apps') },
  { key: 'api-notes', label: 'API 업데이트', tags: 'gear', priority: 3,
    read: async () => parseReleaseNotes(await get('https://docs.claude.com/en/release-notes/overview'), 'https://docs.claude.com/en/release-notes/overview') },
  { key: 'claude-code', label: 'Claude Code 새 버전', tags: 'computer', priority: 3,
    read: async () => (await get('https://api.github.com/repos/anthropics/claude-code/releases?per_page=20', true)).map(r => {
      // 'Added …' 줄만 추린다. 버그 수정뿐인 버전은 알리지 않는다
      const added = (r.body ?? '').split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(s => /^(Added|New|Introduced)\b/.test(s));
      return { id: r.tag_name, title: r.tag_name, detail: added.map(s => '• ' + cut(s.replace(/`/g, ''), 140)).slice(0, 4).join('\n'), url: r.html_url, skip: !added.length };
    }) },
  { key: 'hackernews', label: '해커뉴스 화제', tags: 'fire', priority: 3,
    read: async () => {
      const since = Math.floor(Date.now() / 1000) - 3 * 86400;
      const out = new Map();
      for (const q of ['claude', 'anthropic']) {
        const j = await get(`https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since},points>=150&hitsPerPage=30`, true);
        for (const h of j.hits ?? []) {
          if (!/claude|anthropic/i.test(h.title)) continue;
          out.set(h.objectID, { id: h.objectID, title: h.title, detail: `${h.points}점 · 댓글 ${h.num_comments ?? 0}개${h.url ? '\n' + h.url : ''}`, url: `https://news.ycombinator.com/item?id=${h.objectID}` });
        }
      }
      return [...out.values()];
    } },
];

async function push(msg) {
  if (DRY || !TOPIC) { console.log('  [알림 미발송]', msg.title, '|', cut(msg.message.replace(/\n/g, ' / '), 120)); return; }
  const res = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: TOPIC, ...msg }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ntfy ${res.status} ${await res.text()}`);
}

const kst = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

async function main() {
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { seen: {}, fails: {} };
  const firstRun = !Object.keys(state.seen).length;
  const fresh = [];
  for (const src of SOURCES) {
    let items;
    try {
      items = await src.read();
      if (!items.length) throw new Error('읽은 소식이 0개 (페이지 구조가 바뀌었을 수 있음)');
    } catch (e) {
      state.fails[src.key] = (state.fails[src.key] ?? 0) + 1;
      console.log(`✗ ${src.label}: ${e.message} (연속 ${state.fails[src.key]}회)`);
      if (state.fails[src.key] === FAIL_ALERT) {
        await push({ title: `⚠️ 감지 실패: ${src.label}`, message: `2시간째 읽지 못하고 있어요.\n${e.message}`, tags: ['warning'], priority: 3 });
      }
      continue;
    }
    state.fails[src.key] = 0;
    const seen = new Set(state.seen[src.key] ?? []);
    const news = items.filter(it => !seen.has(it.id));
    console.log(`✓ ${src.label}: ${items.length}개 중 새 소식 ${news.length}개`);
    for (const it of news) if (!it.skip && !firstRun) fresh.push({ src, it });
    state.seen[src.key] = [...items.map(it => it.id), ...(state.seen[src.key] ?? []).filter(id => !items.some(it => it.id === id))].slice(0, KEEP_IDS);
  }

  if (firstRun) {
    const n = Object.values(state.seen).reduce((s, a) => s + a.length, 0);
    await push({ title: '클로드 소식 감지 시작', message: `지금 있는 소식 ${n}개를 기준으로 삼고, 이제부터 새로 나오는 것만 알려 드려요. (${kst()} KST)`, tags: ['white_check_mark'], priority: 3 });
  }
  for (const { src, it } of fresh.slice(0, MAX_PUSH)) {
    await push({ title: `[${src.label}] ${cut(it.title, 100)}`, message: `${cut(it.detail || it.title, 400)}\n\n감지 ${kst()} KST`, click: it.url, tags: [src.tags], priority: src.priority });
  }
  if (fresh.length > MAX_PUSH) {
    await push({ title: `새 소식 ${fresh.length - MAX_PUSH}개 더`, message: fresh.slice(MAX_PUSH).map(f => `[${f.src.label}] ${cut(f.it.title, 60)}`).join('\n'), tags: ['inbox_tray'], priority: 3 });
  }

  if (!DRY) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
