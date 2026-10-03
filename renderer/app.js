'use strict';

/* =========================================================
   Helpers
   ========================================================= */
const API_URL = 'https://graphql.anilist.co';
const bridge = window.api || null; // provided by preload.js inside Electron

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

const clock12 = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const getProfile = () => store.get('profile', { name: '' });
const initial = (name) => (name || 'U').trim().charAt(0).toUpperCase() || 'U';
const getSkip = () => { const n = Number(store.get('skip', 10)); return [5, 10, 15, 20].includes(n) ? n : 10; };
function updateAvatar() {
  const a = $('#avatar');
  if (!a) return;
  const v = AL.viewer;
  if (v?.avatar) { a.innerHTML = `<img src="${esc(v.avatar)}" alt="">`; a.title = `${v.name} (AniList)`; }
  else { a.textContent = initial(getProfile().name); a.title = getProfile().name || 'Settings'; }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function openExternal(url) {
  if (bridge) bridge.openExternal(url); else window.open(url, '_blank', 'noopener');
}

/* =========================================================
   AniList (metadata, covers, legit streaming links)
   ========================================================= */
const CARD = `fragment card on Media {
  id title { romaji english } coverImage { large extraLarge color } bannerImage
  averageScore episodes format genres seasonYear status
}`;
const gqlCache = new Map();

async function gql(query, variables = {}, { auth = false, fresh = false } = {}) {
  const key = query + JSON.stringify(variables);
  if (!fresh && !auth && gqlCache.has(key)) return gqlCache.get(key);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && AL.token) headers.Authorization = `Bearer ${AL.token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    if (auth && (res.status === 401 || res.status === 400)) {
      const j = await res.json().catch(() => ({}));
      const msg = j.errors?.[0]?.message || '';
      if (res.status === 401 || /invalid token|unauthorized/i.test(msg)) { alLogout(true); throw new Error('Your AniList login expired. Log in again in Settings.'); }
      throw new Error(msg || 'AniList request failed.');
    }
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After')) || 5) * 1000);
      continue;
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    if (!auth) gqlCache.set(key, json.data);
    return json.data;
  }
  throw new Error('AniList is rate limiting requests. Wait a minute and try again.');
}

const mediaById = new Map();
const remember = (list) => { (list || []).forEach((m) => m && mediaById.set(m.id, m)); return list || []; };

/* =========================================================
   Persistent user data
   ========================================================= */
const LIST_STATUSES = [['CURRENT', 'Watching'], ['PLANNING', 'Planning'], ['COMPLETED', 'Completed'], ['PAUSED', 'Paused'], ['DROPPED', 'Dropped']];
const statusLabel = (s) => (s === 'REPEATING' ? 'Rewatching' : (LIST_STATUSES.find((x) => x[0] === s) || [0, 'In list'])[1]);
const listTab = (s) => (s === 'REPEATING' ? 'CURRENT' : s);
const getList = () => store.get('mylist', {}); // used when not logged in to AniList

/* ---------- AniList account ---------- */
const AL = { token: store.get('al_token', ''), viewer: store.get('al_viewer', null), entries: new Map(), loaded: false, loading: null };

async function alInit() {
  if (!AL.token) return;
  try {
    const d = await gql(`query { Viewer { id name avatar { large } siteUrl } }`, {}, { auth: true });
    AL.viewer = { id: d.Viewer.id, name: d.Viewer.name, avatar: d.Viewer.avatar?.large, url: d.Viewer.siteUrl };
    store.set('al_viewer', AL.viewer);
    updateAvatar();
    await alLoadList(true);
  } catch (err) { console.warn(err); }
}

function alLoadList(force = false) {
  if (!AL.token || !AL.viewer) return Promise.resolve();
  if (AL.loaded && !force) return Promise.resolve();
  if (AL.loading) return AL.loading;
  AL.loading = (async () => {
    const d = await gql(`query($u: Int) { MediaListCollection(userId: $u, type: ANIME) { lists { entries {
        id status progress score(format: POINT_10) updatedAt media { ...card } } } } } ${CARD}`,
      { u: AL.viewer.id }, { auth: true });
    AL.entries.clear();
    for (const l of d.MediaListCollection.lists || []) {
      for (const e of l.entries || []) {
        if (!AL.entries.has(e.media.id)) AL.entries.set(e.media.id, { id: e.id, status: e.status, progress: e.progress, score: e.score, updatedAt: e.updatedAt, media: e.media });
      }
    }
    remember([...AL.entries.values()].map((e) => e.media));
    AL.loaded = true;
  })().finally(() => { AL.loading = null; });
  return AL.loading;
}

async function alLogin() {
  if (!bridge?.anilistLogin) { toast('Logging in works in the desktop app.'); return; }
  const clientId = ($('#al-client')?.value || store.get('al_client', '')).trim();
  store.set('al_client', clientId);
  const r = await bridge.anilistLogin(clientId);
  if (r?.error) { toast(r.error); return; }
  if (r?.token) await alSetToken(r.token);
}
async function alSetToken(token) {
  AL.token = token.trim(); store.set('al_token', AL.token);
  AL.viewer = null; AL.loaded = false;
  await alInit();
  if (AL.viewer) toast(`Logged in as ${AL.viewer.name}. Your lists are synced.`);
  else { toast('That login didn’t work. Check your client ID and try again.'); alLogout(true); }
  render({ keepScroll: true });
}
function alLogout(silent = false) {
  AL.token = ''; AL.viewer = null; AL.entries.clear(); AL.loaded = false;
  store.set('al_token', ''); store.set('al_viewer', null);
  updateAvatar();
  if (!silent) { toast('Logged out of AniList'); render({ keepScroll: true }); }
}

/* ---------- Which list an anime is in ---------- */
function listEntry(id) {
  if (AL.token && AL.viewer) return AL.entries.get(id) || null;
  const e = getList()[id];
  return e ? { status: e.status || 'PLANNING', progress: 0, media: e, updatedAt: (e.added || 0) / 1000 } : null;
}
const listBtnLabel = (id) => { const e = listEntry(id); return e ? `✓ ${statusLabel(e.status)}` : '+ Add to My List'; };

async function setListStatus(m, status) {
  if (AL.token && AL.viewer) {
    if (status) {
      const d = await gql(`mutation($m: Int, $s: MediaListStatus) { SaveMediaListEntry(mediaId: $m, status: $s) { id status progress score(format: POINT_10) updatedAt } }`,
        { m: m.id, s: status }, { auth: true });
      const e = d.SaveMediaListEntry;
      AL.entries.set(m.id, { id: e.id, status: e.status, progress: e.progress, score: e.score, updatedAt: e.updatedAt, media: { ...snap(m) } });
    } else {
      const cur = AL.entries.get(m.id);
      if (cur) await gql(`mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`, { id: cur.id }, { auth: true });
      AL.entries.delete(m.id);
    }
  } else {
    const l = getList();
    if (status) l[m.id] = { ...snap(m), added: l[m.id]?.added || Date.now(), status };
    else delete l[m.id];
    store.set('mylist', l);
  }
  toast(status ? `Saved ${titleOf(m)} to ${statusLabel(status)}${AL.viewer ? ' on AniList' : ''}` : `Removed ${titleOf(m)} from My List`);
  $$(`[data-action="list-menu"][data-id="${m.id}"]`).forEach((b) => { b.textContent = listBtnLabel(m.id); });
  const top = state.stack[state.stack.length - 1];
  if (top.view === 'mylist' || top.view === 'home') render({ keepScroll: true });
}

/* ---------- "Save to list" popup ---------- */
const modal = $('#modal');
const ICONS = { CURRENT: '▶', PLANNING: '🕒', COMPLETED: '✓', PAUSED: '❚❚', DROPPED: '✕' };
function openListMenu(m, trigger) {
  const cur = listEntry(m.id)?.status;
  const curTab = cur && listTab(cur);
  state.modal = { m, trigger };
  modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="Save to list">
    <h3>Save to list</h3>
    <div class="modal-sub">${esc(titleOf(m))}${AL.viewer ? ' · syncs to AniList' : ''}</div>
    <div class="modal-opts">${LIST_STATUSES.map(([s, l]) => `<button class="modal-opt ${curTab === s ? 'on' : ''}" data-nav data-status="${s}">
      <span class="mi">${ICONS[s]}</span>${l}${curTab === s ? '<span class="tick">Current</span>' : ''}</button>`).join('')}</div>
    <div class="modal-foot">
      ${cur ? `<button class="btn danger" data-nav data-status="">Remove from list</button>` : ''}
      <button class="btn" data-nav data-close>Cancel</button>
    </div></div>`;
  modal.hidden = false;
  ($('.modal-opt.on', modal) || $('.modal-opt', modal)).focus();
}
function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true; modal.innerHTML = '';
  state.modal?.trigger?.focus?.({ preventScroll: true });
  state.modal = null;
}
modal.addEventListener('click', async (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) { closeModal(); return; }
  const b = e.target.closest('[data-status]');
  if (!b || !state.modal) return;
  const { m } = state.modal;
  $$('button', modal).forEach((x) => { x.disabled = true; });
  try { await setListStatus(m, b.dataset.status || null); closeModal(); }
  catch (err) { toast(err.message); $$('button', modal).forEach((x) => { x.disabled = false; }); }
});
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

// Official AniList genres (18+ genres are left out on purpose)
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
// Popular AniList tags shown as extra categories
const TAGS = ['Isekai', 'Shounen', 'Shoujo', 'Seinen', 'Josei', 'Martial Arts', 'Super Power', 'Magic', 'School',
  'Military', 'Historical', 'Samurai', 'Ninja', 'Vampire', 'Demons', 'Gods', 'Dragons', 'Mythology', 'Zombie',
  'Survival', 'Post-Apocalyptic', 'Dystopian', 'Cyberpunk', 'Space', 'Robots', 'Time Manipulation', 'Reincarnation',
  'Video Games', 'Virtual World', 'Detective', 'Crime', 'Tragedy', 'Iyashikei', 'Parody', 'Coming of Age',
  'Found Family', 'Anti-Hero', 'Villainess', 'Urban Fantasy', 'Kaiju', 'Pirates', 'Food', 'Band', 'Idol',
  'Workplace', 'Family Life', 'Delinquents', 'Boys\' Love', 'Yuri', 'Card Battle', 'Esports', 'Racing'];
const CATEGORIES = [...GENRES.map((n) => ({ name: n, kind: 'genre' })), ...TAGS.map((n) => ({ name: n, kind: 'tag' }))];
const catColor = (i) => `hsl(${(i * 47) % 360} 42% 28%)`;
const genreTile = (c, i) =>
  `<button class="genre" data-nav ${c.kind === 'tag' ? 'data-tag' : 'data-genre'}="${esc(c.name)}" style="--g:${catColor(i)}"><span class="glyph">${esc(c.name.slice(0, 2))}</span>${esc(c.name)}</button>`;

const loadingHTML = () => `<div class="loading"><div><div class="spinner"></div>Loading…</div></div>`;
const errorHTML = (err) => `<div class="empty"><h3>Couldn't load this page</h3>
  ${esc(err.message || err)}<br>Check your internet connection, then reload.
  <div><button class="btn accent" data-nav data-action="reload">Reload</button></div></div>`;

/* =========================================================
   Router
   ========================================================= */
const state = { stack: [{ view: 'home', params: {} }], fwd: [], renderId: 0, heroTimer: null, heroIndex: 0, heroes: [] };
const TAB_FOR = { home: 'home', schedule: 'schedule', browse: 'browse', genres: 'genres', movies: 'movies', mylist: 'mylist', library: 'library', settings: 'settings' };

function go(view, params = {}) {
  const top = state.stack[state.stack.length - 1];
  if (top && top.view === view && JSON.stringify(top.params) === JSON.stringify(params)) { render(); return; }
  state.stack.push({ view, params });
  state.fwd = [];
  render();
}
function back() {
  if (state.stack.length > 1) { state.fwd.push(state.stack.pop()); render(); }
}
function forward() {
  if (state.fwd.length) { state.stack.push(state.fwd.pop()); render(); }
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
    await alLoadList().catch(() => {});
    const alWatching = AL.viewer ? [...AL.entries.values()].filter((e) => e.status === 'CURRENT' || e.status === 'REPEATING')
      .sort((a, b) => b.updatedAt - a.updatedAt) : [];
    const airing = d.season.media.map((m) => wideHTML({ media: m, label: [FORMAT[m.format], m.episodes ? `${m.episodes} eps` : 'Airing'].filter(Boolean).join(' / '), time: 0, dur: 0 })
      .replace('data-action="resume" ', '').replace('<div class="prog"><i style="width:0%"></i></div>', '')).join('');

    return {
      html: `
        <div class="hero" id="hero">${heroHTML(state.heroes[0])}</div>
        ${history.length ? rail('Continue watching', history.map(wideHTML).join(''), 'wide-rail') : ''}
        ${alWatching.length ? rail('Watching on AniList', alWatching.map((e) => cardHTML(e.media, { sub: `EP ${e.progress}${e.media.episodes ? ' / ' + e.media.episodes : ''}` })).join('')) : ''}
        ${rail('Airing this season', airing, 'wide-rail')}
        ${rail('Popular categories', CATEGORIES.slice(0, 24).map(genreTile).join(''), 'genres-rail')}
        ${rail('Trending now', trending.map((m) => cardHTML(m)).join(''))}
        ${rail(`Popular this season`, d.season.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Recently started', d.recent.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Top rated', d.top.media.map((m) => cardHTML(m)).join(''))}
        ${rail('All-time popular', d.popular.media.map((m) => cardHTML(m)).join(''))}`,
      after() {
        bindHero();
        state.heroTimer = setInterval(() => {
          const hero = $('#hero');
          if (!hero || hero.contains(document.activeElement) || state.heroes.length < 2) return;
          if (Date.now() - (state.heroTouched || 0) < 9000) return; // user just swiped
          setHero((state.heroIndex + 1) % state.heroes.length, 1);
        }, 9000);
      }
    };
  },

  async browse(params) {
    const d = await browseQuery(browseVars(params, 1));
    const title = params.title || (params.q ? `Results for "${params.q}"` : params.genre || params.tag || 'Browse');
    const chips = params.q || params.format || params.tag ? '' : `<div class="chips">
      <button class="chip ${!params.genre ? 'on' : ''}" data-nav data-genre="">All</button>
      ${GENRES.map((g) => `<button class="chip ${params.genre === g ? 'on' : ''}" data-nav data-genre="${esc(g)}">${esc(g)}</button>`).join('')}
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
    return { html: `<div class="page-title">Genres</div><div class="genre-grid">${CATEGORIES.map(genreTile).join('')}</div>` };
  },

  async movies() {
    return VIEWS.browse({ format: 'MOVIE', title: 'Movies', tab: 'movies' });
  },

  async mylist(params) {
    const tab = params.status || 'ALL';
    let all;
    if (AL.token && AL.viewer) {
      await alLoadList();
      all = [...AL.entries.values()];
    } else {
      all = Object.values(getList()).map((x) => ({ status: x.status || 'PLANNING', progress: 0, media: x, updatedAt: (x.added || 0) / 1000 }));
    }
    remember(all.map((e) => e.media));
    const count = (s) => all.filter((e) => listTab(e.status) === s).length;
    const tabs = [['ALL', 'All', all.length], ...LIST_STATUSES.map(([s, l]) => [s, l, count(s)])];
    // keep AniList's usual order: Watching, Completed, Paused, Dropped, Planning
    const order = ['ALL', 'CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED', 'PLANNING'];
    tabs.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const shown = all.filter((e) => tab === 'ALL' || listTab(e.status) === tab).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const head = AL.viewer
      ? `<div class="list-head"><img src="${esc(AL.viewer.avatar || '')}" alt=""><span>Synced with AniList as <b>${esc(AL.viewer.name)}</b></span>
          <button class="btn small" data-nav data-action="al-refresh">Refresh</button></div>`
      : `<div class="list-head"><span>Saved on this PC. <button class="link-btn inline" data-nav data-go="settings">Log in to AniList</button> to import your AniList lists.</span></div>`;
    const sub = (e) => AL.viewer
      ? `${statusLabel(e.status)} · ${e.progress || 0}/${e.media.episodes || '?'} eps${e.score ? ` · ★ ${e.score}` : ''}`
      : statusLabel(e.status);
    return {
      html: `<div class="page-title">My List</div>${head}
        <div class="chips list-tabs">${tabs.map(([s, l, n]) => `<button class="chip ${s === tab ? 'on' : ''}" data-nav ${s === tab ? 'data-autofocus' : ''} data-action="list-tab" data-status="${s}">${l} <span class="count">${n}</span></button>`).join('')}</div>
        ${shown.length ? `<div class="grid">${shown.map((e) => cardHTML(e.media, { sub: sub(e) })).join('')}</div>`
          : `<div class="empty"><h3>Nothing here yet</h3>Open any anime and press “Add to My List” to save it to a list.
             <div><button class="btn accent" data-nav data-go="browse">Browse anime</button></div></div>`}`
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
    const prof = getProfile();
    const skip = getSkip();
    const hist = Object.values(getHistory()).length, lib = Object.keys(getLibrary()).length;
    const list = AL.viewer ? AL.entries.size : Object.keys(getList()).length;
    const v = AL.viewer;
    const alBlock = v
      ? `<div class="settings-block"><h3>AniList account</h3>
          <div class="profile-row"><img class="avatar big" src="${esc(v.avatar || '')}" alt="">
            <div><div class="al-name">${esc(v.name)}</div><div class="d-sub" style="margin:4px 0 0">Your lists sync both ways with AniList.</div></div></div>
          <div class="btn-row">
            <button class="btn" data-nav data-go="mylist">Open My List</button>
            <button class="btn" data-nav data-action="al-refresh">Refresh lists</button>
            <button class="btn" data-nav data-ext="${esc(v.url || 'https://anilist.co')}">View AniList profile</button>
            <button class="btn danger" data-nav data-action="al-logout">Log out</button>
          </div></div>`
      : `<div class="settings-block"><h3>AniList account</h3>
          <p>Log in to import your Watching, Completed, Paused, Dropped and Planning lists, use your AniList profile picture,
          and save anime to your AniList lists from the app.</p>
          <p><b>One-time setup:</b> open AniList's developer page, click <i>Create New Client</i>, enter any name, and set the
          Redirect URL to <code>https://anilist.co/api/v2/oauth/pin</code>. Then paste the <i>Client ID</i> number below.
          <button class="link-btn inline" data-nav data-ext="https://anilist.co/settings/developer">Open developer page</button></p>
          <div class="field-row">
            <label class="field">Client ID <input id="al-client" type="text" data-nav inputmode="numeric" spellcheck="false" value="${esc(store.get('al_client', ''))}" placeholder="e.g. 12345"></label>
            <button class="btn primary" data-nav data-action="al-login">Log in with AniList</button>
          </div>
          <details class="al-help"><summary data-nav tabindex="0">Login window didn't close by itself?</summary>
            <p>After you approve, AniList shows a long token. Copy it and paste it here.</p>
            <div class="field-row">
              <label class="field">Token <input id="al-token" type="text" data-nav spellcheck="false" placeholder="Paste token"></label>
              <button class="btn" data-nav data-action="al-token">Save token</button>
            </div>
          </details>
        </div>`;
    const keys = [
      ['← ↑ → ↓', 'Move around the app'], ['Enter', 'Open / select'],
      ['Esc or Backspace or Alt+←', 'Go back a page'], ['Alt+→', 'Go forward a page'], ['/', 'Jump to search'],
      ['Ctrl + = or Ctrl + scroll up', 'Zoom in'], ['Ctrl + - or Ctrl + scroll down', 'Zoom out'], ['Ctrl + 0', 'Reset zoom'],
      ['Space or K', 'Play / pause'], ['← or J', `Back ${skip} seconds`], ['→ or L', `Forward ${skip} seconds`],
      ['↑ / ↓', 'Volume'], ['F', 'Fullscreen'], ['M', 'Mute'], ['C', 'Subtitles'], ['N / P', 'Next / previous episode'],
      ['E', 'Episode list (then ↑ ↓ Enter)'], ['0–9', 'Jump to 0%–90%']
    ];
    return {
      html: `<div class="page-title">Settings</div>
      ${v ? '' : `<div class="settings-block"><h3>Profile</h3>
        <div class="profile-row">
          <div class="avatar big" id="avatar-big">${esc(initial(prof.name))}</div>
          <label class="field">Display name
            <input id="pname" type="text" data-nav maxlength="24" value="${esc(prof.name)}" placeholder="Your name"></label>
        </div></div>`}
      ${alBlock}
      <div class="settings-block"><h3>Stats</h3>
        <div class="stats"><div><b>${hist}</b>continue watching</div><div><b>${list}</b>in My List</div><div><b>${lib}</b>with files on disk</div></div>
      </div>
      <div class="settings-block"><h3>Skip forward and back</h3>
        <p>How far the skip buttons, arrow keys and double-click jump in the player.</p>
        <div class="chips">${[5, 10, 15, 20].map((n) => `<button class="chip ${n === skip ? 'on' : ''}" data-nav data-action="set-skip" data-skip="${n}">${n} seconds</button>`).join('')}</div>
      </div>
      <div class="settings-block"><h3>Mouse in the player</h3>
        <p>Click to play or pause. Double-click the left side to go back ${skip} seconds, the right side to go forward ${skip} seconds, or the middle for fullscreen. Mouse side buttons go back and forward a page.</p>
      </div>
      <div class="settings-block"><h3>Keyboard shortcuts</h3>
        <div class="keys">${keys.map(([k, v]) => `<div>${k.split(' or ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' or ')}</div><div>${esc(v)}</div>`).join('')}</div></div>
      <div class="settings-block"><h3>Where info comes from</h3>
        <p>Titles, covers, schedules, descriptions and “Where to watch” links come from AniList. Episodes play from video files you link from your own computer.</p></div>
      <div class="settings-block"><h3>Your data</h3>
        <p>${v ? 'Watch history and linked files are stored on this computer. Your lists live on your AniList account.' : 'Watch history, My List and linked files are stored on this computer only.'}</p>
        <div class="btn-row">
          <button class="btn" data-nav data-action="clear-history">Clear watch history</button>
          ${v ? '' : '<button class="btn" data-nav data-action="clear-list">Clear My List</button>'}
          <button class="btn" data-nav data-action="clear-library">Unlink all files</button>
        </div></div>`,
      after() {
        $('#al-client')?.addEventListener('input', (e) => store.set('al_client', e.target.value.trim()));
        $('#pname')?.addEventListener('input', (e) => {
          const name = e.target.value.trim();
          store.set('profile', { ...getProfile(), name });
          $('#avatar-big').textContent = initial(name);
          updateAvatar();
        });
      }
    };
  },

  async schedule(params) {
    const day = Number(params.day || 0);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + day);
    const s0 = Math.floor(start.getTime() / 1000), s1 = s0 + 86400;
    const all = [];
    for (let page = 1; page <= 4; page++) {
      const d = await gql(`query($p: Int, $a: Int, $b: Int) { Page(page: $p, perPage: 50) { pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $a, airingAt_lesser: $b, sort: TIME) { airingAt episode media { ...card isAdult } } } } ${CARD}`,
        { p: page, a: s0, b: s1 });
      all.push(...d.Page.airingSchedules);
      if (!d.Page.pageInfo.hasNextPage) break;
    }
    const list = all.filter((x) => x.media && !x.media.isAdult);
    remember(list.map((x) => x.media));
    const now = Date.now() / 1000;
    const days = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(); dt.setDate(dt.getDate() + i);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return `<button class="chip ${i === day ? 'on' : ''}" data-nav ${i === day ? 'data-autofocus' : ''} data-action="day" data-day="${i}">${label}</button>`;
    }).join('');
    const rows = list.map((x) => {
      const m = x.media, aired = x.airingAt <= now;
      const left = x.airingAt - now, h = Math.floor(left / 3600), mi = Math.floor((left % 3600) / 60);
      const when = aired ? 'Aired' : h > 0 ? `In ${h}h ${mi}m` : `In ${mi}m`;
      return `<div class="sched ${aired ? 'aired' : ''}" tabindex="0" data-nav data-id="${m.id}">
        <div class="sched-time">${clock12(new Date(x.airingAt * 1000))}</div>
        <img loading="lazy" src="${esc(m.coverImage?.large || '')}" alt="">
        <div class="sched-info"><div class="sched-title">${esc(titleOf(m))}</div>
          <div class="sched-sub">Episode ${x.episode}${m.episodes ? ` of ${m.episodes}` : ''}${FORMAT[m.format] ? ` / ${FORMAT[m.format]}` : ''}</div></div>
        <div class="sched-when">${when}</div>
      </div>`;
    }).join('');
    return {
      html: `<div class="page-title">Airing schedule</div><div class="chips">${days}</div>
        ${rows ? `<div class="sched-list">${rows}</div>` : `<div class="empty"><h3>Nothing airing this day</h3>Pick another day above.</div>`}`
    };
  },

  async detail({ id }) {
    const d = await gql(`query($id: Int) { Media(id: $id) {
      ...card title { native } synonyms description(asHtml: false) duration source season
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
              <button class="btn" data-nav data-action="list-menu" data-id="${m.id}">${listBtnLabel(m.id)}</button>
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

function browseVars(p, page) {
  return { page, q: p.q || undefined, g: p.genre || undefined, t: p.tag || undefined, f: p.format || undefined,
    sort: p.q ? ['SEARCH_MATCH'] : ['POPULARITY_DESC'] };
}
async function browseQuery(vars) {
  return gql(`query($page: Int, $q: String, $g: String, $t: String, $f: MediaFormat, $sort: [MediaSort]) {
    Page(page: $page, perPage: 42) { pageInfo { hasNextPage }
      media(search: $q, genre: $g, tag: $t, format: $f, sort: $sort, type: ANIME, isAdult: false) { ...card } }
  } ${CARD}`, vars);
}

/* ---------- Hero ---------- */
function heroHTML(m) {
  if (!m) return '';
  const desc = cleanDesc(m.description);
  const meta = [(m.genres || []).slice(0, 3).join(', '), m.averageScore ? `<b>★ ${(m.averageScore / 10).toFixed(1)}</b>` : ''].filter(Boolean).join('  •  ');
  const now = m.status === 'RELEASING' ? 'Now airing' : [FORMAT[m.format], m.seasonYear].filter(Boolean).join(', ');
  return `<img class="hero-bg" draggable="false" src="${esc(m.bannerImage)}" alt="">
    <div class="hero-body">
      <h1>${esc(titleOf(m))}</h1>
      <div class="meta">${meta}</div>
      <div class="now">${esc(now)}</div>
      <p>${esc(desc)}</p>
      <div class="btn-row">
        <button class="btn primary" data-nav data-autofocus data-id="${m.id}">
          <svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>View details</button>
        <button class="btn" data-nav data-action="list-menu" data-id="${m.id}">${listBtnLabel(m.id)}</button>
      </div>
    </div>
    <div class="hero-dots">${state.heroes.map((_, i) => `<button class="${i === state.heroIndex ? 'on' : ''}" data-hero="${i}" tabindex="-1" aria-label="Slide ${i + 1}"></button>`).join('')}</div>`;
}
function setHero(i, dir = 0) {
  state.heroIndex = i;
  const hero = $('#hero');
  if (!hero) return;
  hero.innerHTML = heroHTML(state.heroes[i]);
  hero.classList.remove('from-left', 'from-right');
  if (dir) { void hero.offsetWidth; hero.classList.add(dir > 0 ? 'from-right' : 'from-left'); }
}

// Click the banner to open the anime; drag it left/right to switch to the next/previous one
function bindHero() {
  const hero = $('#hero');
  if (!hero) return;
  let startX = null, dx = 0;
  const reset = () => { startX = null; hero.classList.remove('dragging'); hero.style.setProperty('--drag', '0px'); };
  hero.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    startX = e.clientX; dx = 0;
    hero.setPointerCapture(e.pointerId);
    hero.classList.add('dragging');
  });
  hero.addEventListener('pointermove', (e) => {
    if (startX == null) return;
    dx = e.clientX - startX;
    hero.style.setProperty('--drag', `${dx * 0.6}px`);
  });
  hero.addEventListener('pointerup', () => {
    if (startX == null) return;
    const moved = dx;
    reset();
    const n = state.heroes.length;
    if (Math.abs(moved) > 60 && n > 1) {
      state.heroTouched = Date.now();
      const dir = moved < 0 ? 1 : -1; // drag left = next, drag right = previous
      setHero((state.heroIndex + dir + n) % n, dir);
    } else if (Math.abs(moved) < 8) {
      const m = state.heroes[state.heroIndex];
      if (m) go('detail', { id: m.id });
    }
  });
  hero.addEventListener('pointercancel', reset);
  hero.addEventListener('dragstart', (e) => e.preventDefault());
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
  if (!bridge) { toast('Linking files works in the desktop app. Start it with npm start.'); return; }
  const files = await bridge.pickVideos();
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
  if (e.target.closest('#player') || e.target.closest('#modal')) return;
  const t = e.target.closest('[data-go],[data-action],[data-ext],[data-ep],[data-genre],[data-tag],[data-hero],[data-id]');
  if (!t) return;

  if (t.dataset.go) {
    const v = t.dataset.go;
    go(v, v === 'movies' ? { tab: 'movies' } : {});
    return;
  }
  if (t.dataset.hero != null) {
    const i = Number(t.dataset.hero);
    state.heroTouched = Date.now();
    setHero(i, i > state.heroIndex ? 1 : -1); return;
  }
  if (t.dataset.ext) { openExternal(t.dataset.ext); return; }

  const action = t.dataset.action;
  const id = Number(t.dataset.id);
  const m = mediaById.get(id) || state.detail;

  switch (action) {
    case 'list-menu': openListMenu(m, t); return;
    case 'list-tab': state.stack[state.stack.length - 1].params = { status: t.dataset.status }; render(); return;
    case 'al-login': alLogin(); return;
    case 'al-logout': alLogout(); return;
    case 'al-token': { const v = $('#al-token')?.value.trim(); if (v) alSetToken(v); else toast('Paste the token first.'); return; }
    case 'al-refresh':
      t.disabled = true;
      try { await alLoadList(true); toast('Lists refreshed'); render({ keepScroll: true }); }
      catch (err) { toast(err.message); t.disabled = false; }
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
        const d = await browseQuery(browseVars(p, page));
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
    case 'day': state.stack[state.stack.length - 1].params = { day: Number(t.dataset.day) }; render(); return;
    case 'set-skip':
      store.set('skip', Number(t.dataset.skip)); updateSkipUI();
      toast(`Skip set to ${t.dataset.skip} seconds`); render({ keepScroll: true }); return;
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
  if (t.dataset.tag) { go('browse', { tag: t.dataset.tag, tab: 'genres' }); return; }
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
  const scope = modal.hidden ? document : modal;
  return $$('[data-nav]', scope).filter((el) => !el.closest('#player') && el.offsetParent !== null && !el.disabled);
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
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    if (e.key === 'ArrowLeft') { if (P.open) closePlayer(); else back(); }
    else if (!P.open) forward();
    return;
  }
  if (P.open) { playerKey(e); return; }
  if (!modal.hidden) {
    if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); closeModal(); }
    else if (ARROWS[e.key]) { e.preventDefault(); moveFocus(ARROWS[e.key]); }
    return;
  }
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
// Mouse side buttons: 3 = back, 4 = forward
window.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); if (!modal.hidden) closeModal(); else if (P.open) closePlayer(); else back(); }
  if (e.button === 4) { e.preventDefault(); if (!P.open) forward(); }
});

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
  if (bridge && f.path && !(await bridge.fileExists(f.path))) {
    showMsg(`Can't find this file anymore:\n${f.path}\n\nIt may have been moved or deleted. Use “Add more files” on the anime page to link it again.`);
    return;
  }
  video.src = f.url;
  setPreviewSource(f.url);
  video.play().catch(() => {});
  if (f.sub && bridge) {
    const s = await bridge.readSubtitle(f.sub);
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
  setPreviewSource('');
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
function flash(text, side = '') {
  const f = $('#p-flash');
  f.textContent = text; f.classList.add('show');
  f.classList.toggle('left', side === 'left'); f.classList.toggle('right', side === 'right');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 550);
}

function seek(delta, side = '') {
  if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.5, video.currentTime + delta));
  flash(delta < 0 ? `⟲  ${Math.abs(delta)}s` : `${delta}s  ⟳`, side);
  updateProgress();
}
function togglePlay(silent = false) {
  if (!video.src) return;
  if (video.paused) { video.play().catch(() => {}); if (!silent) flash('▶'); } else { video.pause(); if (!silent) flash('❚❚'); }
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
  } else if (bridge) {
    const s = await bridge.pickSubtitle();
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
    case 'ArrowLeft': case 'j': case 'J': seek(-getSkip()); break;
    case 'ArrowRight': case 'l': case 'L': seek(getSkip()); break;
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
  const t = ratio * (video.duration || 0);
  const w = pbar.clientWidth, half = 100;
  $('#pbar-tip').style.left = Math.max(half, Math.min(w - half, ratio * w)) + 'px';
  $('#pbar-time').textContent = fmtTime(t);
  requestPreview(t);
  if (P.dragging && video.duration) { video.currentTime = t; updateProgress(); }
});

/* Hover preview: a second, muted copy of the video that jumps to the hovered time */
const pv = $('#pv');
let pvBusy = false, pvWant = null;
function setPreviewSource(url) {
  pvBusy = false; pvWant = null;
  pv.classList.add('off');
  if (url) pv.src = url; else { pv.removeAttribute('src'); pv.load(); }
}
function requestPreview(t) {
  pvWant = t;
  if (!pvBusy) pvSeek();
}
function pvSeek() {
  if (pvWant == null || !pv.getAttribute('src') || pv.readyState < 1) return;
  pvBusy = true;
  pv.currentTime = pvWant; pvWant = null;
}
pv.addEventListener('loadedmetadata', pvSeek);
pv.addEventListener('seeked', () => {
  pvBusy = false;
  pv.classList.remove('off');
  if (pvWant != null) pvSeek();
});
pv.addEventListener('error', () => { pvBusy = false; pv.classList.add('off'); });
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
// Single click = play/pause. Double-click: left third = back, right third = forward, middle = fullscreen.
// Uses the click count from Windows, so it follows your system double-click speed.
let clickTimer = null, toggledAt = 0;
video.addEventListener('click', (e) => {
  if (e.detail >= 2) {
    clearTimeout(clickTimer); clickTimer = null;
    // a slow double-click may already have toggled play/pause once — undo that
    if (Date.now() - toggledAt < 700) { togglePlay(true); toggledAt = 0; }
    const r = video.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x < 0.35) seek(-getSkip(), 'left');
    else if (x > 0.65) seek(getSkip(), 'right');
    else if (e.detail === 2) toggleFullscreen();
    return;
  }
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clickTimer = null; toggledAt = Date.now(); togglePlay(); }, 250);
});

/* Player buttons — keep focus on the player so keys keep working */
$$('#player button, #vol').forEach((b) => b.addEventListener('mousedown', (e) => { if (b.id !== 'vol') e.preventDefault(); }));
$('#b-play').onclick = togglePlay;
$('#b-back').onclick = () => seek(-getSkip());
$('#b-fwd').onclick = () => seek(getSkip());
function updateSkipUI() {
  const n = getSkip();
  $('#b-back span').textContent = n; $('#b-fwd span').textContent = n;
  $('#b-back').title = `Back ${n} seconds (←)`; $('#b-fwd').title = `Forward ${n} seconds (→)`;
}
updateSkipUI();
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
  const t = clock12(new Date());
  $('#clock').textContent = t; $('#p-clock').textContent = t;
}
tick(); setInterval(tick, 10000);
updateAvatar();
bridge?.onZoom?.((pct) => toast(`Zoom ${pct}%  (Ctrl + 0 to reset)`));
window.addEventListener('beforeunload', saveProgress);

// Log in to AniList in the background (if you were logged in before), then show the page
Promise.race([alInit(), sleep(4000)]).finally(() => render());
