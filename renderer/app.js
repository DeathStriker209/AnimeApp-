'use strict';

/* =========================================================
   Helpers
   ========================================================= */
const API_URL = 'https://graphql.anilist.co';
const api = window.api || null; // provided by preload.js inside Electron

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
};

const titleOf = (m) => m?.title?.english || m?.title?.romaji || 'Untitled';
const cleanDesc = (d) => (d || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const FORMAT = { TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' };
const STATUS = { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'On hiatus' };
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');

function currentSeason() {
  const d = new Date(), mo = d.getMonth();
  return { season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Math.floor(mo / 3)], year: d.getFullYear() };
}

// Keep only what we need to show a card offline (My List, history, library)
function snap(m) {
  return {
    id: m.id, title: m.title, coverImage: m.coverImage, bannerImage: m.bannerImage,
    format: m.format, episodes: m.episodes, seasonYear: m.seasonYear, averageScore: m.averageScore, genres: m.genres
  };
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function openExternal(url) {
  if (api) api.openExternal(url); else window.open(url, '_blank', 'noopener');
}

/* =========================================================
   AniList (metadata, covers, legit streaming links)
   ========================================================= */
const CARD = `fragment card on Media {
  id title { romaji english } coverImage { large extraLarge color } bannerImage
  averageScore episodes format genres seasonYear status
}`;
const gqlCache = new Map();

async function gql(query, variables = {}) {
  const key = query + JSON.stringify(variables);
  if (gqlCache.has(key)) return gqlCache.get(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After')) || 5) * 1000);
      continue;
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    gqlCache.set(key, json.data);
    return json.data;
  }
  throw new Error('AniList is rate limiting requests. Wait a minute and try again.');
}

const mediaById = new Map();
const remember = (list) => { (list || []).forEach((m) => m && mediaById.set(m.id, m)); return list || []; };

/* =========================================================
   Persistent user data
   ========================================================= */
const getList = () => store.get('mylist', {});
const inList = (id) => !!getList()[id];
function toggleList(m) {
  const l = getList();
  if (l[m.id]) { delete l[m.id]; toast(`Removed ${titleOf(m)} from My List`); }
  else { l[m.id] = { ...snap(m), added: Date.now() }; toast(`Added ${titleOf(m)} to My List`); }
  store.set('mylist', l);
}
const getHistory = () => store.get('history', {});
const getLibrary = () => store.get('library', {});

/* =========================================================
   Templates
   ========================================================= */
function cardHTML(m, opts = {}) {
  const score = m.averageScore ? `<span class="card-score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : '';
  const local = getLibrary()[m.id];
  const badge = local ? `<span class="card-badge">ON DISK</span>` : '';
  const sub = opts.sub ?? [FORMAT[m.format], m.episodes ? `${m.episodes} eps` : null, m.seasonYear].filter(Boolean).join(' / ');
  return `<div class="card" tabindex="0" data-nav data-id="${m.id}">
    <div class="card-img" style="--c:${esc(m.coverImage?.color || '#131d2d')}">
      <img loading="lazy" src="${esc(m.coverImage?.large || '')}" alt="">${score}${badge}
    </div>
    <div class="card-title">${esc(titleOf(m))}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

function wideHTML(h) {
  const m = h.media;
  const pct = h.dur ? Math.min(100, (h.time / h.dur) * 100) : 0;
  const img = m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || '';
  return `<div class="wide" tabindex="0" data-nav data-action="resume" data-id="${m.id}">
    <img loading="lazy" src="${esc(img)}" alt="">
    <div class="wide-body">
      <div class="wide-title">${esc(titleOf(m))}</div>
      <div class="wide-sub">${h.label ? esc(h.label) : `Ep ${h.ep}`}${h.dur ? ` / ${Math.round(h.time / 60)}/${Math.round(h.dur / 60)} min` : ''}</div>
      <div class="prog"><i style="width:${pct}%"></i></div>
    </div>
  </div>`;
}

const rail = (title, inner, cls = '') => inner ? `<h2 class="section">${esc(title)}</h2><div class="rail ${cls}">${inner}</div>` : '';

const GENRES = [
  ['Action', '#7a2b2b'], ['Adventure', '#7a5a22'], ['Comedy', '#6b6a1f'], ['Drama', '#5a2d6b'],
  ['Fantasy', '#2b4f7a'], ['Horror', '#3d1e24'], ['Mecha', '#3e4a5c'], ['Music', '#6b2a55'],
  ['Mystery', '#2f2a5e'], ['Psychological', '#4b2d4f'], ['Romance', '#7a2b4d'], ['Sci-Fi', '#1f5a6b'],
  ['Slice of Life', '#2b6b5e'], ['Sports', '#2b6b3a'], ['Supernatural', '#4a2b7a'], ['Thriller', '#5c3a1e']
];
const genreTile = ([g, color]) =>
  `<button class="genre" data-nav data-genre="${esc(g)}" style="--g:${color}"><span class="glyph">${esc(g.slice(0, 2))}</span>${esc(g)}</button>`;

const loadingHTML = () => `<div class="loading"><div><div class="spinner"></div>Loading…</div></div>`;
const errorHTML = (err) => `<div class="empty"><h3>Couldn't load this page</h3>
  ${esc(err.message || err)}<br>Check your internet connection, then reload.
  <div><button class="btn accent" data-nav data-action="reload">Reload</button></div></div>`;

/* =========================================================
   Router
   ========================================================= */
const state = { stack: [{ view: 'home', params: {} }], renderId: 0, heroTimer: null, heroIndex: 0, heroes: [] };
const TAB_FOR = { home: 'home', browse: 'browse', genres: 'genres', movies: 'movies', mylist: 'mylist', library: 'library', settings: 'settings' };

function go(view, params = {}, { reset = false } = {}) {
  if (reset) state.stack = [];
  state.stack.push({ view, params });
  render();
}
function back() {
  if (state.stack.length > 1) { state.stack.pop(); render(); }
}

async function render({ keepScroll = false } = {}) {
  const id = ++state.renderId;
  const { view, params } = state.stack[state.stack.length - 1];
  clearInterval(state.heroTimer);
  const tab = params.tab || TAB_FOR[view];
  $$('[data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === tab));

  const el = $('#view');
  const scroll = el.scrollTop;
  if (!keepScroll) el.innerHTML = loadingHTML();
  let out;
  try { out = await VIEWS[view](params); }
  catch (err) { console.error(err); out = { html: errorHTML(err) }; }
  if (id !== state.renderId) return; // user moved on while this was loading
  el.innerHTML = out.html;
  el.scrollTop = keepScroll ? scroll : 0;
  out.after?.();
  if (!keepScroll || !el.contains(document.activeElement)) focusFirst();
}

function focusFirst() {
  const el = $('[data-autofocus]', $('#view')) || $('[data-nav]', $('#view'));
  el?.focus({ preventScroll: true });
}

/* =========================================================
   Views
   ========================================================= */
const VIEWS = {
  async home() {
    const { season, year } = currentSeason();
    const d = await gql(`query($season: MediaSeason, $year: Int) {
      trending: Page(perPage: 20) { media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ...card description(asHtml: false) } }
      season: Page(perPage: 20) { media(season: $season, seasonYear: $year, sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...card } }
      recent: Page(perPage: 20) { media(sort: START_DATE_DESC, type: ANIME, isAdult: false, status: RELEASING, popularity_greater: 3000) { ...card } }
      top: Page(perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false, popularity_greater: 20000) { ...card } }
      popular: Page(perPage: 20) { media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...card } }
    } ${CARD}`, { season, year });

    const trending = remember(d.trending.media);
    remember(d.season.media); remember(d.recent.media); remember(d.top.media); remember(d.popular.media);
    state.heroes = trending.filter((m) => m.bannerImage).slice(0, 6);
    state.heroIndex = 0;

    const history = Object.values(getHistory()).sort((a, b) => b.at - a.at);
    const side = history.length
      ? `<h2 class="section">Continue watching</h2><div class="side-list">${history.slice(0, 3).map(wideHTML).join('')}</div>`
      : `<h2 class="section">Airing this season</h2><div class="side-list">${d.season.media.slice(0, 3)
          .map((m) => wideHTML({ media: m, label: [FORMAT[m.format], m.episodes ? `${m.episodes} eps` : 'Airing'].filter(Boolean).join(' / '), time: 0, dur: 0 }).replace('data-action="resume" ', '')).join('')}</div>`;

    return {
      html: `
        <section class="home-top">
          <div class="hero" id="hero">${heroHTML(state.heroes[0])}</div>
          <aside class="side">${side}</aside>
        </section>
        ${history.length > 3 ? rail('Continue watching', history.map(wideHTML).join(''), 'wide-rail') : ''}
        ${rail('Popular categories', GENRES.map(genreTile).join(''), 'genres-rail')}
        ${rail('Trending now', trending.map((m) => cardHTML(m)).join(''))}
        ${rail(`Popular this season`, d.season.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Recently started', d.recent.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Top rated', d.top.media.map((m) => cardHTML(m)).join(''))}
        ${rail('All-time popular', d.popular.media.map((m) => cardHTML(m)).join(''))}`,
      after() {
        state.heroTimer = setInterval(() => {
          const hero = $('#hero');
          if (!hero || hero.contains(document.activeElement) || state.heroes.length < 2) return;
          setHero((state.heroIndex + 1) % state.heroes.length);
        }, 9000);
      }
    };
  },

  async browse(params) {
    const vars = { page: 1, q: params.q || undefined, g: params.genre || undefined, f: params.format || undefined,
      sort: params.q ? ['SEARCH_MATCH'] : ['POPULARITY_DESC'] };
    const d = await browseQuery(vars);
    const title = params.title || (params.q ? `Results for "${params.q}"` : params.genre ? params.genre : 'Browse');
    const chips = params.q || params.format ? '' : `<div class="chips">
      <button class="chip ${!params.genre ? 'on' : ''}" data-nav data-genre="">All</button>
      ${GENRES.map(([g]) => `<button class="chip ${params.genre === g ? 'on' : ''}" data-nav data-genre="${esc(g)}">${esc(g)}</button>`).join('')}
    </div>`;
    const list = remember(d.Page.media);
    return {
      html: `<div class="page-title">${esc(title)}</div>${chips}
        ${list.length ? `<div class="grid" id="grid">${list.map((m) => cardHTML(m)).join('')}</div>`
          : `<div class="empty"><h3>No matches</h3>Try a different spelling or the English title.</div>`}
        <div class="more-wrap">${d.Page.pageInfo.hasNextPage ? `<button class="btn" data-nav data-action="more" data-page="2">Load more</button>` : ''}</div>`
    };
  },

  async genres() {
    return { html: `<div class="page-title">Genres</div><div class="genre-grid">${GENRES.map(genreTile).join('')}</div>` };
  },

  async movies() {
    return VIEWS.browse({ format: 'MOVIE', title: 'Movies', tab: 'movies' });
  },

  async mylist() {
    const items = Object.values(getList()).sort((a, b) => b.added - a.added);
    remember(items);
    return {
      html: `<div class="page-title">My List</div>` + (items.length
        ? `<div class="grid">${items.map((m) => cardHTML(m)).join('')}</div>`
        : `<div class="empty"><h3>Your list is empty</h3>Open any anime and choose “Add to My List” to keep it here.
             <div><button class="btn accent" data-nav data-go="browse">Browse anime</button></div></div>`)
    };
  },

  async library() {
    const lib = Object.values(getLibrary());
    remember(lib.map((e) => e.media));
    return {
      html: `<div class="page-title">My Library</div>` + (lib.length
        ? `<div class="grid">${lib.map((e) => cardHTML(e.media, { sub: `${e.files.length} episode${e.files.length === 1 ? '' : 's'} on disk` })).join('')}</div>`
        : `<div class="empty"><h3>No episodes on disk yet</h3>
             Open an anime, choose “Link episode files”, and pick the video files you own.
             They'll play here in the built-in player.
             <div><button class="btn accent" data-nav data-go="browse">Find an anime</button></div></div>`)
    };
  },

  async settings() {
    const keys = [
      ['← ↑ → ↓', 'Move around the app'], ['Enter', 'Open / select'], ['Esc or Backspace', 'Go back'], ['/', 'Jump to search'],
      ['Space or K', 'Play / pause (player)'], ['← / J', 'Back 10 seconds'], ['→ / L', 'Forward 10 seconds'],
      ['↑ / ↓', 'Volume'], ['F', 'Fullscreen'], ['M', 'Mute'], ['C', 'Subtitles'], ['N / P', 'Next / previous episode'],
      ['E', 'Episode list (then ↑ ↓ Enter)'], ['0–9', 'Jump to 0%–90%']
    ];
    return {
      html: `<div class="page-title">Profile & settings</div>
      <div class="settings-block"><h3>Keyboard shortcuts</h3>
        <div class="keys">${keys.map(([k, v]) => `<div>${k.split(' or ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' or ')}</div><div>${esc(v)}</div>`).join('')}</div></div>
      <div class="settings-block"><h3>Where info comes from</h3>
        <p>Titles, covers, descriptions and “Where to watch” links come from AniList. Episodes play from video files you link from your own computer.</p></div>
      <div class="settings-block"><h3>Your data</h3>
        <p>Watch history, My List and linked files are stored on this computer only.</p>
        <div class="btn-row">
          <button class="btn" data-nav data-action="clear-history">Clear watch history</button>
          <button class="btn" data-nav data-action="clear-list">Clear My List</button>
          <button class="btn" data-nav data-action="clear-library">Unlink all files</button>
        </div></div>`
    };
  },

  async detail({ id }) {
    const d = await gql(`query($id: Int) { Media(id: $id) {
      ...card title { native } description(asHtml: false) duration source season
      studios(isMain: true) { nodes { name } }
      trailer { id site }
      externalLinks { site url type color }
      nextAiringEpisode { episode airingAt }
      streamingEpisodes { title thumbnail url site }
      recommendations(perPage: 14, sort: RATING_DESC) { nodes { mediaRecommendation { ...card } } }
    } } ${CARD}`, { id });
    const m = d.Media;
    remember([m]);
    const recs = remember((m.recommendations?.nodes || []).map((n) => n.mediaRecommendation).filter(Boolean));
    state.detail = m;
    state.epChunk = 0;

    const desc = cleanDesc(m.description) || 'No description available.';
    const studio = m.studios?.nodes?.[0]?.name;
    const facts = [
      m.averageScore ? `<span class="fact score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : '',
      FORMAT[m.format] && `<span class="fact">${FORMAT[m.format]}</span>`,
      STATUS[m.status] && `<span class="fact">${STATUS[m.status]}</span>`,
      m.season && m.seasonYear ? `<span class="fact">${cap(m.season)} ${m.seasonYear}</span>` : m.seasonYear ? `<span class="fact">${m.seasonYear}</span>` : '',
      m.episodes ? `<span class="fact">${m.episodes} episodes</span>` : '',
      m.duration ? `<span class="fact">${m.duration} min</span>` : '',
      studio ? `<span class="fact">${esc(studio)}</span>` : '',
      ...(m.genres || []).map((g) => `<span class="fact">${esc(g)}</span>`)
    ].filter(Boolean).join('');

    const lib = getLibrary()[m.id];
    const hist = getHistory()[m.id];
    const playBtn = lib
      ? `<button class="btn primary" data-nav data-autofocus data-action="play" data-id="${m.id}" data-ep="${hist?.ep || lib.files[0].ep}">
           <svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>${hist ? `Resume EP ${hist.ep}` : `Play EP ${lib.files[0].ep}`}</button>`
      : '';
    const streaming = (m.externalLinks || []).filter((l) => l.type === 'STREAMING');

    return {
      html: `<div class="detail">
        <div class="d-banner">${m.bannerImage ? `<img src="${esc(m.bannerImage)}" alt="">` : ''}</div>
        <div class="d-main">
          <div class="d-cover"><img src="${esc(m.coverImage?.extraLarge || m.coverImage?.large || '')}" alt=""></div>
          <div class="d-info">
            <h1>${esc(titleOf(m))}</h1>
            <div class="d-native">${esc([m.title.romaji !== titleOf(m) ? m.title.romaji : '', m.title.native].filter(Boolean).join('  ·  '))}</div>
            <div class="d-facts">${facts}</div>
            <p class="d-desc clamp" id="desc">${esc(desc)}</p>
            ${desc.length > 420 ? `<button class="link-btn" data-nav data-action="more-desc">Read more</button>` : ''}
            <div class="btn-row">
              ${playBtn}
              <button class="btn ${lib ? '' : 'primary'}" data-nav ${lib ? '' : 'data-autofocus'} data-action="link" data-id="${m.id}">
                <svg viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"/></svg>${lib ? 'Add more files' : 'Link episode files'}</button>
              <button class="btn" data-nav data-action="toggle-list" data-id="${m.id}">${inList(m.id) ? '✓ In My List' : '+ Add to My List'}</button>
              ${m.trailer?.site === 'youtube' ? `<button class="btn" data-nav data-ext="https://www.youtube.com/watch?v=${esc(m.trailer.id)}">Watch trailer</button>` : ''}
              ${lib ? `<button class="btn" data-nav data-action="unlink" data-id="${m.id}">Unlink files</button>` : ''}
            </div>
          </div>
        </div>
        ${streaming.length ? `<div class="d-section"><h2 class="section">Where to watch</h2>
          <div class="chips">${streaming.map((l) => `<button class="chip ext" data-nav data-ext="${esc(l.url)}" style="--dot:${esc(l.color || '#4aa8ff')}"><i></i>${esc(l.site)}</button>`).join('')}</div></div>` : ''}
        <div class="d-section"><h2 class="section">Episodes</h2>
          <div class="d-sub">${lib ? `${lib.files.length} on disk. ` : ''}Episodes without a linked file open on an official site when one is available.</div>
          <div id="ep-area">${episodesHTML(m)}</div></div>
        ${recs.length ? `<div class="d-section">${rail('You might also like', recs.map((r) => cardHTML(r)).join(''))}</div>` : ''}
      </div>`
    };
  }
};

async function browseQuery(vars) {
  return gql(`query($page: Int, $q: String, $g: String, $f: MediaFormat, $sort: [MediaSort]) {
    Page(page: $page, perPage: 42) { pageInfo { hasNextPage }
      media(search: $q, genre: $g, format: $f, sort: $sort, type: ANIME, isAdult: false) { ...card } }
  } ${CARD}`, vars);
}

/* ---------- Hero ---------- */
function heroHTML(m) {
  if (!m) return '';
  const desc = cleanDesc(m.description);
  const meta = [(m.genres || []).slice(0, 3).join(', '), m.averageScore ? `<b>★ ${(m.averageScore / 10).toFixed(1)}</b>` : ''].filter(Boolean).join('  •  ');
  const now = m.status === 'RELEASING' ? 'Now airing' : [FORMAT[m.format], m.seasonYear].filter(Boolean).join(', ');
  return `<img class="hero-bg" src="${esc(m.bannerImage)}" alt="">
    <div class="hero-body">
      <h1>${esc(titleOf(m))}</h1>
      <div class="meta">${meta}</div>
      <div class="now">${esc(now)}</div>
      <p>${esc(desc)}</p>
      <div class="btn-row">
        <button class="btn primary" data-nav data-autofocus data-id="${m.id}">
          <svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>View details</button>
        <button class="btn" data-nav data-action="toggle-list" data-id="${m.id}">${inList(m.id) ? '✓ In My List' : '+ Add to My List'}</button>
      </div>
    </div>
    <div class="hero-dots">${state.heroes.map((_, i) => `<button class="${i === state.heroIndex ? 'on' : ''}" data-hero="${i}" tabindex="-1" aria-label="Slide ${i + 1}"></button>`).join('')}</div>`;
}
function setHero(i) {
  state.heroIndex = i;
  const hero = $('#hero');
  if (hero) hero.innerHTML = heroHTML(state.heroes[i]);
}

/* ---------- Episodes on detail page ---------- */
const CHUNK = 100;
function episodeCount(m) {
  const lib = getLibrary()[m.id];
  const localMax = lib ? Math.max(...lib.files.map((f) => f.ep)) : 0;
  const streamMax = Math.max(0, ...streamMap(m).keys());
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0;
  return Math.max(m.episodes || 0, aired, streamMax, localMax, m.format === 'MOVIE' ? 1 : 0);
}
function streamMap(m) {
  const map = new Map();
  (m.streamingEpisodes || []).forEach((s) => {
    const n = Number((s.title || '').match(/(?:Episode|Ep\.?)\s*(\d+)/i)?.[1]);
    if (n && !map.has(n)) map.set(n, s);
  });
  return map;
}
function episodesHTML(m) {
  const total = episodeCount(m);
  if (!total) return `<div class="d-sub">Episode info isn't available yet.</div>`;
  const lib = getLibrary()[m.id];
  const local = new Map((lib?.files || []).map((f) => [f.ep, f]));
  const streams = streamMap(m);
  const hist = getHistory()[m.id];
  const cover = m.bannerImage || m.coverImage?.extraLarge || '';
  const start = state.epChunk * CHUNK + 1, end = Math.min(total, start + CHUNK - 1);

  let chunks = '';
  if (total > CHUNK) {
    const n = Math.ceil(total / CHUNK);
    chunks = `<div class="chips">${Array.from({ length: n }, (_, i) =>
      `<button class="chip ${i === state.epChunk ? 'on' : ''}" data-nav data-action="chunk" data-chunk="${i}">${i * CHUNK + 1}–${Math.min(total, (i + 1) * CHUNK)}</button>`).join('')}</div>`;
  }

  let tiles = '';
  for (let n = start; n <= end; n++) {
    const f = local.get(n), s = streams.get(n);
    const cls = f ? 'local' : s ? 'stream' : 'missing';
    const thumb = s?.thumbnail || cover;
    const name = s ? s.title.replace(/^(?:Episode|Ep\.?)\s*\d+\s*[-:–]\s*/i, '') : '';
    const badge = f ? 'Play' : s ? esc(s.site || 'Watch online') : 'Not linked';
    const prog = hist && hist.ep === n && hist.dur ? `<div class="prog"><i style="width:${Math.min(100, hist.time / hist.dur * 100)}%"></i></div>` : '';
    const lock = cls === 'missing' ? `<div class="ep-lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>` : '';
    tiles += `<div class="ep ${cls}" tabindex="0" data-nav data-ep="${n}">
      <div class="ep-thumb"><img loading="lazy" src="${esc(thumb)}" alt="">${lock}<span class="ep-badge">${badge}</span>${prog}</div>
      <div class="ep-title">EP ${n}</div>
      <div class="ep-sub">${esc(f ? f.name : name || (s ? '' : 'Link a file to play'))}</div>
    </div>`;
  }
  return chunks + `<div class="ep-grid">${tiles}</div>`;
}

/* =========================================================
   Linking local files
   ========================================================= */
function guessEp(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const patterns = [/S\d{1,2}\s*E(\d{1,4})/i, /\b(?:ep|episode|e)\s*\.?\s*(\d{1,4})\b/i, /\s[-–]\s*(\d{1,4})\b/];
  for (const re of patterns) { const x = base.match(re); if (x) return Number(x[1]); }
  const nums = [...base.matchAll(/(?<![\dx])(\d{1,4})(?![\dp])/gi)].map((x) => Number(x[1]))
    .filter((n) => ![480, 720, 1080, 2160, 264, 265].includes(n) && !(n >= 1950 && n <= 2099));
  return nums.length ? nums[nums.length - 1] : null;
}

async function linkFiles(m) {
  if (!api) { toast('Linking files works in the desktop app. Start it with npm start.'); return; }
  const files = await api.pickVideos();
  if (!files.length) return;
  const lib = getLibrary();
  const entry = lib[m.id] || { media: snap(m), files: [] };
  const byEp = new Map(entry.files.map((f) => [f.ep, f]));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let next = Math.max(0, ...byEp.keys()) + 1;
  if (files.length === 1 && m.format === 'MOVIE') {
    byEp.set(1, { ...files[0], ep: 1 });
  } else {
    for (const f of files) {
      let n = guessEp(f.name);
      if (!n) n = next;
      byEp.set(n, { ...f, ep: n });
      next = Math.max(next, n + 1);
    }
  }
  entry.files = [...byEp.values()].sort((a, b) => a.ep - b.ep);
  entry.media = snap(m);
  lib[m.id] = entry;
  store.set('library', lib);
  toast(`Linked ${files.length} file${files.length === 1 ? '' : 's'} to ${titleOf(m)}`);
  render({ keepScroll: true });
}

/* =========================================================
   Click handling (mouse and Enter key)
   ========================================================= */
document.addEventListener('click', async (e) => {
  if (e.target.closest('#player')) return;
  const t = e.target.closest('[data-go],[data-action],[data-ext],[data-ep],[data-genre],[data-hero],[data-id]');
  if (!t) return;

  if (t.dataset.go) {
    const v = t.dataset.go;
    if (v === 'movies') go('movies', { tab: 'movies' }, { reset: true });
    else go(v, {}, { reset: true });
    return;
  }
  if (t.dataset.hero != null) { setHero(Number(t.dataset.hero)); return; }
  if (t.dataset.ext) { openExternal(t.dataset.ext); return; }

  const action = t.dataset.action;
  const id = Number(t.dataset.id);
  const m = mediaById.get(id) || state.detail;

  switch (action) {
    case 'toggle-list':
      toggleList(m);
      t.textContent = inList(m.id) ? '✓ In My List' : '+ Add to My List';
      return;
    case 'link': linkFiles(m); return;
    case 'unlink': {
      const lib = getLibrary(); delete lib[id]; store.set('library', lib);
      toast('Files unlinked'); render({ keepScroll: true }); return;
    }
    case 'play': openPlayer(id, Number(t.dataset.ep)); return;
    case 'resume': {
      const h = getHistory()[id];
      if (getLibrary()[id] && h) openPlayer(id, h.ep); else go('detail', { id });
      return;
    }
    case 'more-desc': $('#desc')?.classList.remove('clamp'); t.remove(); return;
    case 'chunk':
      state.epChunk = Number(t.dataset.chunk);
      $('#ep-area').innerHTML = episodesHTML(state.detail);
      $(`[data-chunk="${state.epChunk}"]`)?.focus();
      return;
    case 'more': {
      const page = Number(t.dataset.page);
      const { params } = state.stack[state.stack.length - 1];
      const p = state.stack[state.stack.length - 1].view === 'movies' ? { format: 'MOVIE' } : params;
      t.disabled = true; t.textContent = 'Loading…';
      try {
        const d = await browseQuery({ page, q: p.q || undefined, g: p.genre || undefined, f: p.format || undefined,
          sort: p.q ? ['SEARCH_MATCH'] : ['POPULARITY_DESC'] });
        const list = remember(d.Page.media);
        const grid = $('#grid');
        const firstNew = grid.children.length;
        grid.insertAdjacentHTML('beforeend', list.map((x) => cardHTML(x)).join(''));
        grid.children[firstNew]?.focus();
        if (d.Page.pageInfo.hasNextPage) { t.disabled = false; t.textContent = 'Load more'; t.dataset.page = page + 1; }
        else t.remove();
      } catch (err) { t.disabled = false; t.textContent = 'Load more'; toast(err.message); }
      return;
    }
    case 'reload': gqlCache.clear(); render(); return;
    case 'clear-history': store.set('history', {}); toast('Watch history cleared'); return;
    case 'clear-list': store.set('mylist', {}); toast('My List cleared'); return;
    case 'clear-library': store.set('library', {}); toast('All files unlinked'); return;
  }

  if (t.dataset.ep && state.detail) {
    const n = Number(t.dataset.ep);
    const m2 = state.detail;
    const f = getLibrary()[m2.id]?.files.find((x) => x.ep === n);
    if (f) return openPlayer(m2.id, n);
    const s = streamMap(m2).get(n);
    if (s?.url) return openExternal(s.url);
    toast(`EP ${n} has no file linked yet. Choose the episode files you have.`);
    return linkFiles(m2);
  }
  if (t.dataset.genre != null) {
    const g = t.dataset.genre;
    const inBrowse = state.stack[state.stack.length - 1].view === 'browse';
    if (inBrowse) { state.stack[state.stack.length - 1].params = g ? { genre: g } : {}; render(); }
    else go('browse', { genre: g, tab: 'browse' });
    return;
  }
  if (id) go('detail', { id });
});

/* ---------- Search ---------- */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (q.length < 2) return;
    const top = state.stack[state.stack.length - 1];
    if (top.view === 'browse' && top.params.q) { top.params = { q, tab: 'browse' }; render(); }
    else go('browse', { q, tab: 'browse' });
  }, 450);
});

/* =========================================================
   Spatial keyboard navigation
   ========================================================= */
function navigables() {
  return $$('[data-nav]').filter((el) => !el.closest('#player') && el.offsetParent !== null && !el.disabled);
}

function moveFocus(dir) {
  const all = navigables();
  const cur = document.activeElement;
  if (!cur || !all.includes(cur)) { focusFirst(); return; }
  // Prefer content first so rows below the fold win over the always-visible header/footer
  const view = $('#view');
  const best = findBest(cur, dir, all.filter((el) => view.contains(el))) || findBest(cur, dir, all.filter((el) => !view.contains(el)));
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

function findBest(cur, dir, els) {
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;

  for (const el of els) {
    if (el === cur) continue;
    const q = el.getBoundingClientRect();
    const ex = q.left + q.width / 2, ey = q.top + q.height / 2;
    const dx = ex - cx, dy = ey - cy;
    let primary, secondary;
    if (dir === 'left' || dir === 'right') {
      if (dir === 'right' && dx <= 4) continue;
      if (dir === 'left' && dx >= -4) continue;
      const vOverlap = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      if (vOverlap <= Math.min(r.height, q.height) * 0.3) continue; // stay on the same row
      primary = Math.abs(dx); secondary = Math.abs(dy);
    } else {
      if (dir === 'down' && q.top < r.bottom - 4) continue;
      if (dir === 'up' && q.bottom > r.top + 4) continue;
      primary = Math.abs(dy);
      const hOverlap = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      secondary = hOverlap > 0 ? 0 : Math.min(Math.abs(q.left - r.right), Math.abs(r.left - q.right));
    }
    const score = primary + secondary * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

document.addEventListener('keydown', (e) => {
  document.body.classList.add('kbd');
  if (P.open) { playerKey(e); return; }
  const t = e.target;
  const typing = t.matches?.('input[type="search"], input[type="text"], textarea');

  if (ARROWS[e.key]) {
    if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    moveFocus(ARROWS[e.key]);
  } else if (e.key === 'Enter') {
    if (typing) {
      e.preventDefault();
      const q = t.value.trim();
      clearTimeout(searchTimer);
      if (q) go('browse', { q, tab: 'browse' });
    } else if (t.matches?.('[data-nav]') && !t.matches('button')) {
      e.preventDefault(); t.click();
    }
  } else if (e.key === 'Escape') {
    if (typing) { t.blur(); focusFirst(); } else back();
  } else if (e.key === 'Backspace' && !typing) {
    e.preventDefault(); back();
  } else if (e.key === '/' && !typing) {
    e.preventDefault(); $('#search').focus(); $('#search').select();
  }
});
document.addEventListener('mousedown', () => document.body.classList.remove('kbd'));
window.addEventListener('mouseup', (e) => { if (e.button === 3) back(); }); // mouse "back" button

/* =========================================================
   Player
   ========================================================= */
const P = { open: false, id: 0, media: null, files: [], ep: 0, resumeAt: 0, listMode: false, sel: 0, idleTimer: null, lastSave: 0, subOn: false, dragging: false };
const player = $('#player');
const video = $('#video');

function openPlayer(id, ep) {
  const entry = getLibrary()[id];
  if (!entry?.files.length) { toast('Link episode files first.'); return; }
  P.id = id; P.media = entry.media; P.files = entry.files; P.open = true; P.listMode = false;
  player.hidden = false;
  player.classList.remove('list-mode');
  video.volume = store.get('volume', 1);
  video.muted = store.get('muted', false);
  syncVolume();
  buildEpisodeList();
  loadEpisode(P.files.some((f) => f.ep === ep) ? ep : P.files[0].ep);
  player.focus();
  wake();
}

async function loadEpisode(ep) {
  const f = P.files.find((x) => x.ep === ep);
  if (!f) return;
  if (P.ep && P.ep !== ep) saveProgress();
  P.ep = ep;
  $('#p-msg').hidden = true;
  $('#p-name').textContent = `${titleOf(P.media)} – EP ${ep}`;
  $('#p-sub').textContent = f.name;
  $('#p-quality').textContent = '—';
  $$('track', video).forEach((tr) => tr.remove());
  P.subOn = false; updateSubsUI();

  const h = getHistory()[P.id];
  P.resumeAt = h && h.ep === ep && h.dur && h.time < h.dur - 20 ? h.time : 0;

  video.pause();
  video.removeAttribute('src');
  if (api && f.path && !(await api.fileExists(f.path))) {
    showMsg(`Can't find this file anymore:\n${f.path}\n\nIt may have been moved or deleted. Use “Add more files” on the anime page to link it again.`);
    return;
  }
  video.src = f.url;
  video.play().catch(() => {});
  if (f.sub && api) {
    const s = await api.readSubtitle(f.sub);
    if (s) addSubtitle(s.text, s.name);
  }
  highlightEpisode();
}

function closePlayer() {
  saveProgress();
  P.open = false;
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  player.hidden = true;
  player.classList.remove('idle', 'playing');
  render({ keepScroll: true });
}

function saveProgress() {
  if (!P.id || !P.ep || !video.duration || !isFinite(video.duration)) return;
  const hist = getHistory();
  let ep = P.ep, time = video.currentTime;
  const dur = video.duration;
  if (time > dur - 20) {
    // finished: point "continue watching" at the next episode if we have it
    const next = P.files.find((f) => f.ep > P.ep);
    if (next) { ep = next.ep; time = 0; }
  }
  hist[P.id] = { media: P.media, ep, time, dur: ep === P.ep ? dur : 0, at: Date.now() };
  store.set('history', hist);
}

function buildEpisodeList() {
  const max = Math.max(P.media.episodes || 0, ...P.files.map((f) => f.ep));
  const have = new Map(P.files.map((f) => [f.ep, f]));
  const thumb = P.media.bannerImage || P.media.coverImage?.large || '';
  let html = '';
  for (let n = 1; n <= max; n++) {
    const f = have.get(n);
    html += `<div class="p-ep ${f ? '' : 'missing'}" data-pep="${n}">
      <img src="${esc(thumb)}" alt="" loading="lazy">
      <div><b>EP ${n}</b><small>${f ? 'Ready' : 'Not linked'}</small></div></div>`;
  }
  $('#p-eps').innerHTML = html;
}
function highlightEpisode() {
  $$('.p-ep').forEach((el) => {
    const on = Number(el.dataset.pep) === P.ep;
    el.classList.toggle('current', on);
    const small = $('small', el);
    if (!el.classList.contains('missing')) small.textContent = on ? `Now playing${video.duration ? ' – ' + Math.round(video.duration / 60) + 'm' : ''}` : 'Ready';
  });
  $('.p-ep.current')?.scrollIntoView({ block: 'nearest' });
}

function showMsg(text) { const m = $('#p-msg'); m.textContent = text; m.style.whiteSpace = 'pre-line'; m.hidden = false; }

let flashTimer;
function flash(text) {
  const f = $('#p-flash');
  f.textContent = text; f.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 550);
}

function seek(delta) {
  if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.5, video.currentTime + delta));
  flash(delta < 0 ? `⟲  ${Math.abs(delta)}s` : `${delta}s  ⟳`);
  updateProgress();
}
function togglePlay() {
  if (!video.src) return;
  if (video.paused) { video.play().catch(() => {}); flash('▶'); } else { video.pause(); flash('❚❚'); }
}
function setVolume(v) {
  video.volume = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
  video.muted = video.volume === 0;
  store.set('volume', video.volume); store.set('muted', video.muted);
  flash(`Volume ${Math.round(video.volume * 100)}%`);
  syncVolume();
}
function syncVolume() {
  $('#vol').value = video.muted ? 0 : video.volume;
  player.classList.toggle('muted', video.muted || video.volume === 0);
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else player.requestFullscreen().catch(() => {});
}
function stepEpisode(dir) {
  const idx = P.files.findIndex((f) => f.ep === P.ep);
  const f = P.files[idx + dir];
  if (f) { loadEpisode(f.ep); flash(`EP ${f.ep}`); } else flash(dir > 0 ? 'Last episode' : 'First episode');
}

/* Subtitles */
function srtToVtt(text) {
  if (/^\uFEFF?WEBVTT/.test(text)) return text;
  return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}
function addSubtitle(text, name) {
  $$('track', video).forEach((tr) => tr.remove());
  const track = document.createElement('track');
  track.kind = 'subtitles'; track.label = name || 'Subtitles'; track.srclang = 'en';
  track.src = URL.createObjectURL(new Blob([srtToVtt(text)], { type: 'text/vtt' }));
  video.appendChild(track);
  track.track.mode = 'showing';
  P.subOn = true; updateSubsUI();
}
async function toggleSubs() {
  const tr = video.textTracks[0];
  if (tr) {
    P.subOn = !P.subOn;
    tr.mode = P.subOn ? 'showing' : 'hidden';
    flash(P.subOn ? 'Subtitles on' : 'Subtitles off');
  } else if (api) {
    const s = await api.pickSubtitle();
    if (s) { addSubtitle(s.text, s.name); flash('Subtitles on'); }
  } else flash('No subtitles');
  updateSubsUI();
}
function updateSubsUI() {
  $('#b-cc').classList.toggle('on', P.subOn);
  $('#p-subs-pill').hidden = !P.subOn;
}

/* Episode list mode (keyboard) */
function enterListMode() {
  player.classList.remove('list-hidden');
  P.listMode = true;
  P.sel = Math.max(0, $$('.p-ep').findIndex((el) => Number(el.dataset.pep) === P.ep));
  player.classList.add('list-mode');
  markSel();
}
function exitListMode() {
  P.listMode = false;
  player.classList.remove('list-mode');
  $$('.p-ep.sel').forEach((el) => el.classList.remove('sel'));
}
function markSel() {
  const items = $$('.p-ep');
  items.forEach((el, i) => el.classList.toggle('sel', i === P.sel));
  items[P.sel]?.scrollIntoView({ block: 'nearest' });
}

function playerKey(e) {
  const k = e.key;
  wake();
  if (P.listMode) {
    const items = $$('.p-ep');
    if (k === 'ArrowDown') P.sel = Math.min(items.length - 1, P.sel + 1);
    else if (k === 'ArrowUp') P.sel = Math.max(0, P.sel - 1);
    else if (k === 'Enter') {
      const n = Number(items[P.sel]?.dataset.pep);
      if (P.files.some((f) => f.ep === n)) { loadEpisode(n); exitListMode(); } else flash('Not linked');
    } else if (['e', 'E', 'Escape', 'ArrowLeft', 'Backspace'].includes(k)) exitListMode();
    else return;
    e.preventDefault();
    if (P.listMode) markSel();
    return;
  }

  switch (k) {
    case ' ': case 'k': case 'K': togglePlay(); break;
    case 'ArrowLeft': case 'j': case 'J': seek(-10); break;
    case 'ArrowRight': case 'l': case 'L': seek(10); break;
    case 'ArrowUp': setVolume(video.volume + 0.05); break;
    case 'ArrowDown': setVolume(video.volume - 0.05); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': video.muted = !video.muted; store.set('muted', video.muted); syncVolume(); flash(video.muted ? 'Muted' : 'Sound on'); break;
    case 'c': case 'C': toggleSubs(); break;
    case 'n': case 'N': stepEpisode(1); break;
    case 'p': case 'P': stepEpisode(-1); break;
    case 'e': case 'E': enterListMode(); break;
    case 'Home': video.currentTime = 0; break;
    case 'End': if (video.duration) video.currentTime = video.duration - 1; break;
    case 'Escape': if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else closePlayer(); break;
    case 'Backspace': closePlayer(); break;
    default:
      if (/^[0-9]$/.test(k) && video.duration) { video.currentTime = video.duration * Number(k) / 10; flash(`${Number(k) * 10}%`); break; }
      return;
  }
  e.preventDefault();
}

/* Auto-hide controls */
function wake() {
  player.classList.remove('idle');
  clearTimeout(P.idleTimer);
  P.idleTimer = setTimeout(() => {
    if (P.open && !video.paused && !P.listMode && !P.dragging) player.classList.add('idle');
  }, 3000);
}
player.addEventListener('mousemove', wake);

/* Progress bar */
function updateProgress() {
  const d = video.duration || 0, t = video.currentTime || 0;
  const pct = d ? (t / d) * 100 : 0;
  $('#pbar-fill').style.width = pct + '%';
  $('#pbar-knob').style.left = pct + '%';
  $('#p-time').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  if (video.buffered.length && d) $('#pbar-buf').style.width = (video.buffered.end(video.buffered.length - 1) / d) * 100 + '%';
}
const pbar = $('#pbar');
const ratioAt = (e) => { const r = pbar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
pbar.addEventListener('pointerdown', (e) => {
  if (!video.duration) return;
  P.dragging = true; pbar.setPointerCapture(e.pointerId);
  video.currentTime = ratioAt(e) * video.duration; updateProgress();
});
pbar.addEventListener('pointermove', (e) => {
  const ratio = ratioAt(e);
  const tip = $('#pbar-tip');
  tip.style.left = ratio * 100 + '%';
  tip.textContent = fmtTime(ratio * (video.duration || 0));
  if (P.dragging && video.duration) { video.currentTime = ratio * video.duration; updateProgress(); }
});
pbar.addEventListener('pointerup', () => { P.dragging = false; });

/* Video events */
video.addEventListener('loadedmetadata', () => {
  if (P.resumeAt) { video.currentTime = P.resumeAt; flash(`Resumed at ${fmtTime(P.resumeAt)}`); P.resumeAt = 0; }
  $('#p-quality').textContent = video.videoHeight ? `${video.videoHeight}p` : '—';
  updateProgress(); highlightEpisode();
});
video.addEventListener('timeupdate', () => {
  updateProgress();
  if (Date.now() - P.lastSave > 5000) { P.lastSave = Date.now(); saveProgress(); }
});
video.addEventListener('progress', updateProgress);
video.addEventListener('play', () => { player.classList.add('playing'); wake(); });
video.addEventListener('pause', () => { player.classList.remove('playing', 'idle'); saveProgress(); });
video.addEventListener('ended', () => {
  saveProgress();
  const next = P.files.find((f) => f.ep > P.ep);
  if (next) { flash(`Up next: EP ${next.ep}`); setTimeout(() => P.open && loadEpisode(next.ep), 1500); }
  else flash('Finished');
});
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  showMsg('This file can\'t be played.\nThe app plays MP4 and WebM, and MKV files encoded with H.264.\nFiles using HEVC (x265) or AC3/DTS audio may need converting to MP4 first.');
});
video.addEventListener('click', togglePlay);
video.addEventListener('dblclick', toggleFullscreen);

/* Player buttons — keep focus on the player so keys keep working */
$$('#player button, #vol').forEach((b) => b.addEventListener('mousedown', (e) => { if (b.id !== 'vol') e.preventDefault(); }));
$('#b-play').onclick = togglePlay;
$('#b-back').onclick = () => seek(-10);
$('#b-fwd').onclick = () => seek(10);
$('#b-prev').onclick = () => stepEpisode(-1);
$('#b-next').onclick = () => stepEpisode(1);
$('#b-mute').onclick = () => { video.muted = !video.muted; store.set('muted', video.muted); syncVolume(); };
$('#vol').oninput = (e) => { video.volume = Number(e.target.value); video.muted = video.volume === 0; store.set('volume', video.volume); store.set('muted', video.muted); syncVolume(); };
$('#vol').onchange = () => player.focus();
$('#b-cc').onclick = toggleSubs;
$('#b-full').onclick = toggleFullscreen;
$('#b-list').onclick = () => player.classList.toggle('list-hidden');
$('#p-close').onclick = closePlayer;
$('#p-eps').addEventListener('click', (e) => {
  const el = e.target.closest('.p-ep');
  if (el && !el.classList.contains('missing')) { loadEpisode(Number(el.dataset.pep)); exitListMode(); }
});

/* =========================================================
   Clock & start
   ========================================================= */
function tick() {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  $('#clock').textContent = t; $('#p-clock').textContent = t;
}
tick(); setInterval(tick, 10000);
window.addEventListener('beforeunload', saveProgress);

render();
