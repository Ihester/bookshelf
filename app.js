"use strict";

const STORAGE_KEY = "myBookshelf.books.v1";
const TAGS_KEY = "myBookshelf.tags.v1";
const SETTINGS_KEY = "myBookshelf.settings.v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  books: [],
  tags: [],
  settings: { layout: "list", sortBy: "addedAt-desc" },
  filter: { status: "all", type: "all", source: "all", tag: "all", search: "" },
  pendingBook: null,
  editingId: null,
  selectedSearch: new Map(), // key -> book
  searchGroups: [],
  scanner: { stream: null, running: false, detector: null, rafId: null }
};

state.books = loadBooks();
state.tags = loadTags();
state.settings = loadSettings();

/* ---------- Storage ---------- */
function loadBooks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveBooks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.books));
}
function loadTags() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAGS_KEY));
    if (Array.isArray(stored)) return stored;
  } catch {}
  const set = new Set();
  state.books.forEach((b) => (b.tags || []).forEach((t) => set.add(t)));
  return [...set];
}
function saveTags() {
  localStorage.setItem(TAGS_KEY, JSON.stringify(state.tags));
}
function loadSettings() {
  const defaults = { layout: "list", sortBy: "addedAt-desc" };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return Object.assign(defaults, stored || {});
  } catch {
    return defaults;
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Helpers ---------- */
function normalizeIsbn(s) {
  return (s || "").replace(/[^0-9Xx]/g, "");
}
function isValidIsbn(s) {
  const n = normalizeIsbn(s);
  return n.length === 10 || n.length === 13;
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- OpenCC: Simplified -> Taiwan Traditional ---------- */
let openccConverter = null;
let openccLoading = null;
function ensureOpenCC() {
  if (openccConverter) return Promise.resolve(openccConverter);
  if (openccLoading) return openccLoading;
  openccLoading = new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (typeof window.OpenCC !== "undefined") {
        try {
          openccConverter = window.OpenCC.Converter({ from: "cn", to: "tw" });
        } catch { openccConverter = null; }
        return resolve(openccConverter);
      }
      if (Date.now() - start > 8000) return resolve(null);
      setTimeout(check, 120);
    };
    check();
  });
  return openccLoading;
}
function s2t(text) {
  if (!text || !openccConverter) return text || "";
  try { return openccConverter(text); } catch { return text; }
}

/* ---------- Cover ---------- */
function improveCoverUrl(url) {
  if (!url) return "";
  let u = url.replace(/^http:/, "https:");
  u = u.replace(/zoom=1(?!\d)/, "zoom=2");
  u = u.replace(/&edge=curl/, "");
  return u;
}
function coverHtml(src) {
  if (!src) return `<div class="cover"></div>`;
  return `<div class="cover"><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.dataset.failed=1" /></div>`;
}

/* ---------- Google Books ---------- */
async function fetchGoogleBooksPage(q, startIndex = 0, maxResults = 40) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${maxResults}&startIndex=${startIndex}&printType=books`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return data.items || [];
  } catch {
    return [];
  }
}

function rawItemKey(item) {
  if (item.id) return `id:${item.id}`;
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = (ids.find((x) => x.type === "ISBN_13") ||
                ids.find((x) => x.type === "ISBN_10") || {}).identifier;
  return isbn ? `isbn:${isbn}` : `t:${v.title}|a:${(v.authors || []).join("")}`;
}

async function googleBooksSearch(query) {
  await ensureOpenCC();
  const q = (query || "").trim();
  if (!q) return [];

  const hasOperator = /^(intitle|inauthor|isbn|inpublisher|subject):/i.test(q);
  const looksLikeIsbn = /^\d{9,13}[Xx\d]?$/.test(q);

  // 直接查詢的情況：已含限定詞 / ISBN 數字 → 單次查詢即可
  if (hasOperator || looksLikeIsbn) {
    const items = await fetchGoogleBooksPage(q);
    return items.map(toBookData);
  }

  // 一般搜尋：同時打 intitle:Q（書名精準）和 Q（廣泛比對），合併去重
  const [titleItems, generalItems] = await Promise.all([
    fetchGoogleBooksPage(`intitle:${q}`, 0, 40),
    fetchGoogleBooksPage(q, 0, 40)
  ]);

  const seen = new Set();
  const merged = [];
  // intitle 結果優先（標題精準匹配 → 相關性較高）
  for (const it of [...titleItems, ...generalItems]) {
    const k = rawItemKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
  }
  return merged.map(toBookData);
}

async function googleBooksByIsbn(isbn) {
  const items = await googleBooksSearch(`isbn:${isbn}`);
  if (items.length) return items;
  return googleBooksSearch(isbn);
}
function toBookData(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn13 = ids.find((x) => x.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((x) => x.type === "ISBN_10")?.identifier;
  const cover = improveCoverUrl(
    v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || ""
  );
  const titleParts = [v.title, v.subtitle].filter(Boolean);
  return {
    title: s2t(titleParts.join(" ") || "(無標題)"),
    author: s2t((v.authors || []).join(", ")),
    isbn: isbn13 || isbn10 || "",
    cover,
    publisher: s2t(v.publisher || ""),
    publishedDate: v.publishedDate || ""
  };
}

/* ---------- Series grouping ---------- */
function stripVolume(title) {
  let t = (title || "").trim();
  t = t.replace(/\s*[\(（]\s*\d+\s*[\)）]\s*$/, "");
  t = t.replace(/\s*vol(ume)?\.?\s*\d+\s*$/i, "");
  t = t.replace(/\s*第\s*[\d一二三四五六七八九十百千]+\s*[集卷冊回部章]\s*$/, "");
  t = t.replace(/\s*[\d一二三四五六七八九十百千]+\s*[集卷冊回部章]\s*$/, "");
  t = t.replace(/\s+(上|下|中|前|後)\s*[集卷冊]?\s*$/, "");
  t = t.replace(/[\s\-:：]+\d+\s*$/, "");
  return t.trim();
}
function groupSeries(items) {
  const map = new Map();
  const groups = [];
  for (const it of items) {
    const base = stripVolume(it.title) || it.title;
    const key = `${base}|${it.author}`;
    if (map.has(key)) {
      map.get(key).volumes.push(it);
    } else {
      const g = { id: key, baseTitle: base, author: it.author, volumes: [it] };
      map.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}
function bookKey(b) {
  return b.isbn ? `isbn:${b.isbn}` : `t:${b.title}|a:${b.author || ""}`;
}

/* ---------- Render ---------- */
function statusLabel(s) { return s === "read" ? "已讀" : "未讀"; }
function typeLabel(t) { return t === "ebook" ? "電子書" : "實體書"; }
function sourceLabel(s) {
  if (s === "library") return "圖書館";
  if (s === "borrowed") return "借閱";
  return "自有";
}

/* ---------- Volume-aware sort helpers ---------- */
const CN_NUM = { 〇:0, 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 百:100, 千:1000, 兩:2 };

function chineseNumeralToInt(s) {
  if (!s) return 0;
  if (s.length === 1) return CN_NUM[s] ?? 0;
  let total = 0;
  let current = 0;
  for (const ch of s) {
    const v = CN_NUM[ch];
    if (v == null) return 0;
    if (v >= 10) { total += (current || 1) * v; current = 0; }
    else { current = v; }
  }
  return total + current;
}

function extractVolumeNumber(title, base) {
  if (!title) return 0;
  const rest = title.slice((base || "").length).trim();
  if (!rest) return 0;
  // 阿拉伯數字
  const m = rest.match(/\d+/);
  if (m) return parseInt(m[0], 10);
  // 全形數字
  const fw = rest.match(/[\uFF10-\uFF19]+/);
  if (fw) {
    const n = fw[0].replace(/[\uFF10-\uFF19]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30));
    return parseInt(n, 10);
  }
  // 中文數字
  const cn = rest.match(/[〇零一二三四五六七八九十百千兩]+/);
  if (cn) return chineseNumeralToInt(cn[0]);
  // 上中下 / 前後
  if (/前|上/.test(rest)) return 1;
  if (/中/.test(rest)) return 2;
  if (/後|下/.test(rest)) return 3;
  return 0;
}

const cmpStr = (a, b) =>
  (a || "").localeCompare(b || "", "zh-Hant", { numeric: true });

function compareByTitleWithVolume(a, b) {
  const baseA = stripVolume(a.title) || a.title;
  const baseB = stripVolume(b.title) || b.title;
  const baseCmp = cmpStr(baseA, baseB);
  if (baseCmp !== 0) return baseCmp;
  // 同系列 → 用解析出的集數做數值比較
  const volA = extractVolumeNumber(a.title, baseA);
  const volB = extractVolumeNumber(b.title, baseB);
  if (volA !== volB) return volA - volB;
  return cmpStr(a.title, b.title);
}

function sortBooks(books, sortBy) {
  const arr = [...books];
  switch (sortBy) {
    case "addedAt-asc":
      return arr.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    case "title-asc":
      return arr.sort(compareByTitleWithVolume);
    case "title-desc":
      return arr.sort((a, b) => -compareByTitleWithVolume(a, b));
    case "author-asc":
      return arr.sort((a, b) => {
        const c = cmpStr(a.author, b.author);
        return c !== 0 ? c : compareByTitleWithVolume(a, b);
      });
    case "author-desc":
      return arr.sort((a, b) => {
        const c = cmpStr(b.author, a.author);
        return c !== 0 ? c : compareByTitleWithVolume(a, b);
      });
    case "publishedDate-asc":
      return arr.sort((a, b) => (a.publishedDate || "").localeCompare(b.publishedDate || "")
        || compareByTitleWithVolume(a, b));
    case "publishedDate-desc":
      return arr.sort((a, b) => (b.publishedDate || "").localeCompare(a.publishedDate || "")
        || compareByTitleWithVolume(a, b));
    case "status-unread":
      return arr.sort((a, b) => {
        if (a.status !== b.status) return a.status === "unread" ? -1 : 1;
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
    case "status-read":
      return arr.sort((a, b) => {
        if (a.status !== b.status) return a.status === "read" ? -1 : 1;
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
    case "addedAt-desc":
    default:
      return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }
}

function applyFilters(books) {
  const { status, type, source, tag, search } = state.filter;
  const q = search.trim().toLowerCase();
  return books.filter((b) => {
    if (status !== "all" && b.status !== status) return false;
    if (type !== "all" && b.type !== type) return false;
    if (source !== "all") {
      const s = b.source || "owned";
      if (s !== source) return false;
    }
    if (tag !== "all") {
      const tags = b.tags || [];
      if (tag === "__none__") {
        if (tags.length) return false;
      } else if (!tags.includes(tag)) return false;
    }
    if (q) {
      const hay = `${b.title} ${b.author} ${b.isbn} ${(b.tags||[]).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  refreshTagFilter();
  const list = $("#book-list");
  const empty = $("#empty-hint");
  const filtered = sortBooks(applyFilters(state.books), state.settings.sortBy);

  list.className = `book-list layout-${state.settings.layout}`;
  list.innerHTML = filtered.map(bookCardHtml).join("");

  if (state.books.length === 0) {
    empty.classList.remove("hidden");
    empty.innerHTML = "還沒有任何書籍。點右下角的 <strong>＋</strong> 開始登錄第一本書！";
  } else if (filtered.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = "沒有符合篩選條件的書。";
  } else {
    empty.classList.add("hidden");
  }

  const total = state.books.length;
  const read = state.books.filter((b) => b.status === "read").length;
  $("#stats").textContent = total ? `${read} / ${total} 已讀` : "尚無書籍";

  list.querySelectorAll("[data-id]").forEach((el) => {
    el.addEventListener("click", () => openEdit(el.dataset.id));
  });
}

function refreshTagFilter() {
  const sel = $("#filter-tag");
  if (!sel) return;
  const current = state.filter.tag;
  sel.innerHTML = [
    `<option value="all">全部標籤</option>`,
    `<option value="__none__">未分類</option>`,
    ...state.tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
  ].join("");
  if (current === "all" || current === "__none__" || state.tags.includes(current)) {
    sel.value = current;
  } else {
    sel.value = "all";
    state.filter.tag = "all";
  }
}

function bookCardHtml(b) {
  const tagBadges = (b.tags || [])
    .map((t) => `<span class="badge tag">${escapeHtml(t)}</span>`)
    .join("");
  const src = b.source || "owned";
  const sourceBadge = src !== "owned"
    ? `<span class="badge source-${src}">${sourceLabel(src)}</span>` : "";
  return `
    <article class="book-card" data-id="${b.id}">
      ${coverHtml(b.cover)}
      <div class="meta">
        <p class="title">${escapeHtml(b.title)}</p>
        <p class="author">${escapeHtml(b.author || "（未知作者）")}</p>
        <div class="badges">
          <span class="badge ${b.status}">${statusLabel(b.status)}</span>
          <span class="badge ${b.type}">${typeLabel(b.type)}</span>
          ${sourceBadge}
          ${tagBadges}
          ${b.isbn ? `<span class="badge">ISBN ${escapeHtml(b.isbn)}</span>` : ""}
        </div>
      </div>
    </article>
  `;
}

/* ---------- Tag picker (chips inside dialogs) ---------- */
function renderTagPicker(containerSel, selected) {
  const c = $(containerSel);
  c.innerHTML = "";
  state.tags.forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tag-chip" + (selected.includes(tag) ? " selected" : "");
    btn.textContent = tag;
    btn.dataset.tag = tag;
    btn.addEventListener("click", () => btn.classList.toggle("selected"));
    c.appendChild(btn);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tag-chip add";
  add.textContent = "＋ 新增標籤";
  add.addEventListener("click", () => {
    const name = (prompt("新標籤名稱：") || "").trim();
    if (!name) return;
    if (!state.tags.includes(name)) {
      state.tags.push(name);
      saveTags();
    }
    const cur = getSelectedTags(containerSel);
    if (!cur.includes(name)) cur.push(name);
    renderTagPicker(containerSel, cur);
  });
  c.appendChild(add);
}
function getSelectedTags(containerSel) {
  return [...$(containerSel).querySelectorAll(".tag-chip.selected")]
    .map((b) => b.dataset.tag);
}

/* ---------- Add / Confirm flow ---------- */
function openAddDialog() {
  $("#search-results").innerHTML = "";
  $("#search-input").value = "";
  $("#manual-isbn").value = "";
  state.selectedSearch.clear();
  state.searchGroups = [];
  updateMultiAddBar();
  switchTab("scan");
  $("#add-dialog").showModal();
}
function closeAddDialog() {
  stopScanner();
  state.selectedSearch.clear();
  updateMultiAddBar();
  $("#add-dialog").close();
}
function switchTab(name) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  if (name === "scan") {
    maybeAutoStartScanner();
  } else {
    stopScanner();
  }
}

/* ---------- Search results with multi-select & series grouping ---------- */
function showSearchResults(items) {
  state.selectedSearch.clear();
  state.searchGroups = groupSeries(items);
  renderSearchResults();
  updateMultiAddBar();
}

function renderSearchResults() {
  const box = $("#search-results");
  if (!state.searchGroups.length) {
    box.innerHTML = `<p class="hint">找不到結果。可以試試別的關鍵字。</p>`;
    return;
  }
  box.innerHTML = state.searchGroups.map((g, gi) => {
    if (g.volumes.length === 1) {
      return singleResultHtml(g.volumes[0], gi);
    }
    return seriesGroupHtml(g, gi);
  }).join("");
  wireSearchEvents();
}

function singleResultHtml(book, gi) {
  const k = bookKey(book);
  return `
    <div class="result-item single" data-gi="${gi}" data-key="${escapeHtml(k)}">
      <input type="checkbox" class="result-check" aria-label="選取" />
      ${coverHtml(book.cover)}
      <div class="meta">
        <strong>${escapeHtml(book.title)}</strong>
        <small>${escapeHtml(book.author || "")}${book.publishedDate ? " · " + escapeHtml(book.publishedDate) : ""}</small>
        ${book.isbn ? `<small>ISBN ${escapeHtml(book.isbn)}</small>` : ""}
      </div>
    </div>
  `;
}

function seriesGroupHtml(group, gi) {
  const cover = group.volumes[0].cover;
  const volsHtml = group.volumes.map((v, vi) => {
    const label = v.title.startsWith(group.baseTitle)
      ? (v.title.slice(group.baseTitle.length).trim() || v.title)
      : v.title;
    const k = bookKey(v);
    return `
      <div class="vol-item" data-gi="${gi}" data-vi="${vi}" data-key="${escapeHtml(k)}">
        <input type="checkbox" class="vol-check" aria-label="選取" />
        ${coverHtml(v.cover)}
        <div class="meta">
          <strong>${escapeHtml(label)}</strong>
          ${v.isbn ? `<small>ISBN ${escapeHtml(v.isbn)}</small>` : ""}
        </div>
      </div>
    `;
  }).join("");
  return `
    <div class="series-group" data-gi="${gi}">
      <div class="series-header">
        <input type="checkbox" class="series-check" aria-label="選取整個系列" />
        ${coverHtml(cover)}
        <div class="meta">
          <strong>${escapeHtml(group.baseTitle)}</strong>
          <small>${escapeHtml(group.author || "")} · 共 ${group.volumes.length} 集</small>
        </div>
        <button class="caret" type="button" aria-label="展開">▼</button>
      </div>
      <div class="series-volumes hidden">${volsHtml}</div>
    </div>
  `;
}

function wireSearchEvents() {
  const box = $("#search-results");

  // Single-result rows: toggle on row click or checkbox
  box.querySelectorAll(".result-item.single").forEach((row) => {
    const gi = +row.dataset.gi;
    const book = state.searchGroups[gi].volumes[0];
    const key = row.dataset.key;
    const cb = row.querySelector(".result-check");
    cb.addEventListener("change", () => toggleSelect(key, book, cb.checked));
    row.addEventListener("click", (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      toggleSelect(key, book, cb.checked);
    });
  });

  // Series groups
  box.querySelectorAll(".series-group").forEach((groupEl) => {
    const gi = +groupEl.dataset.gi;
    const group = state.searchGroups[gi];
    const header = groupEl.querySelector(".series-header");
    const caret = groupEl.querySelector(".caret");
    const volsBox = groupEl.querySelector(".series-volumes");
    const seriesCheck = groupEl.querySelector(".series-check");

    // Expand/collapse on header click (but not on checkbox)
    header.addEventListener("click", (e) => {
      if (e.target === seriesCheck) return;
      const open = volsBox.classList.toggle("hidden") === false;
      caret.textContent = open ? "▲" : "▼";
    });

    // Series checkbox toggles all volumes
    seriesCheck.addEventListener("click", (e) => e.stopPropagation());
    seriesCheck.addEventListener("change", () => {
      const checked = seriesCheck.checked;
      group.volumes.forEach((v) => {
        const k = bookKey(v);
        if (checked) state.selectedSearch.set(k, v);
        else state.selectedSearch.delete(k);
      });
      groupEl.querySelectorAll(".vol-check").forEach((c) => (c.checked = checked));
      seriesCheck.indeterminate = false;
      updateMultiAddBar();
    });

    // Individual volume rows
    groupEl.querySelectorAll(".vol-item").forEach((row) => {
      const vi = +row.dataset.vi;
      const v = group.volumes[vi];
      const key = row.dataset.key;
      const cb = row.querySelector(".vol-check");
      cb.addEventListener("change", () => {
        toggleSelect(key, v, cb.checked);
        syncSeriesCheck(group, groupEl);
      });
      row.addEventListener("click", (e) => {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        toggleSelect(key, v, cb.checked);
        syncSeriesCheck(group, groupEl);
      });
    });
  });
}

function toggleSelect(key, book, checked) {
  if (checked) state.selectedSearch.set(key, book);
  else state.selectedSearch.delete(key);
  updateMultiAddBar();
}

function syncSeriesCheck(group, groupEl) {
  const all = group.volumes.every((v) => state.selectedSearch.has(bookKey(v)));
  const some = group.volumes.some((v) => state.selectedSearch.has(bookKey(v)));
  const sc = groupEl.querySelector(".series-check");
  sc.checked = all;
  sc.indeterminate = !all && some;
}

function updateMultiAddBar() {
  const bar = $("#multi-add-bar");
  if (!bar) return;
  const n = state.selectedSearch.size;
  if (n === 0) {
    bar.classList.add("hidden");
  } else {
    bar.classList.remove("hidden");
    $("#multi-add-count").textContent = n;
  }
}

/* ---------- Confirm (single book from scan / manual ISBN) ---------- */
function openConfirm(book) {
  state.pendingBook = book;
  const cover = $("#confirm-cover");
  cover.removeAttribute("data-failed");
  cover.style.display = book.cover ? "" : "none";
  cover.src = book.cover || "";
  $("#confirm-title").textContent = book.title;
  $("#confirm-author").textContent = book.author || "（未知作者）";
  $("#confirm-isbn").textContent = book.isbn ? `ISBN ${book.isbn}` : "";
  $("#confirm-status").value = "unread";
  $("#confirm-type").value = "physical";
  $("#confirm-source").value = "owned";
  $("#confirm-note").value = "";
  renderTagPicker("#confirm-tag-picker", []);
  $("#confirm-dialog").showModal();
}

function commitNewBook() {
  const b = state.pendingBook;
  if (!b) return;
  state.books.push({
    id: uid(),
    title: b.title,
    author: b.author,
    isbn: b.isbn,
    cover: b.cover,
    publisher: b.publisher,
    publishedDate: b.publishedDate,
    status: $("#confirm-status").value,
    type: $("#confirm-type").value,
    source: $("#confirm-source").value,
    note: $("#confirm-note").value.trim(),
    tags: getSelectedTags("#confirm-tag-picker"),
    addedAt: Date.now()
  });
  saveBooks();
  state.pendingBook = null;
  $("#confirm-dialog").close();
  closeAddDialog();
  render();
}

/* ---------- Multi-confirm (batch from search) ---------- */
function openMultiConfirm() {
  const n = state.selectedSearch.size;
  if (n === 0) return;
  $("#multi-confirm-title").textContent = `加入 ${n} 本書`;
  $("#multi-confirm-status").value = "unread";
  $("#multi-confirm-type").value = "physical";
  $("#multi-confirm-source").value = "owned";
  renderTagPicker("#multi-confirm-tag-picker", []);
  // Preview thumbnails
  const preview = $("#multi-confirm-list");
  preview.innerHTML = [...state.selectedSearch.values()].map((b) => `
    <div class="multi-preview-item">
      ${coverHtml(b.cover)}
      <span>${escapeHtml(b.title)}</span>
    </div>
  `).join("");
  $("#multi-confirm-dialog").showModal();
}

function commitMultiBooks() {
  const status = $("#multi-confirm-status").value;
  const type = $("#multi-confirm-type").value;
  const source = $("#multi-confirm-source").value;
  const tags = getSelectedTags("#multi-confirm-tag-picker");

  const existing = new Set(state.books.map((b) => b.isbn).filter(Boolean));
  const total = state.selectedSearch.size;
  let added = 0;
  for (const book of state.selectedSearch.values()) {
    if (book.isbn && existing.has(book.isbn)) continue;
    state.books.push({
      id: uid(),
      title: book.title,
      author: book.author,
      isbn: book.isbn,
      cover: book.cover,
      publisher: book.publisher,
      publishedDate: book.publishedDate,
      status,
      type,
      source,
      note: "",
      tags: [...tags],
      addedAt: Date.now()
    });
    if (book.isbn) existing.add(book.isbn);
    added++;
  }
  saveBooks();
  state.selectedSearch.clear();
  $("#multi-confirm-dialog").close();
  closeAddDialog();
  render();
  if (added < total) {
    setTimeout(() => alert(`已加入 ${added} 本（${total - added} 本因 ISBN 重複略過）`), 100);
  }
}

/* ---------- Edit ---------- */
function openEdit(id) {
  const b = state.books.find((x) => x.id === id);
  if (!b) return;
  state.editingId = id;
  const cover = $("#edit-cover");
  cover.removeAttribute("data-failed");
  cover.style.display = b.cover ? "" : "none";
  cover.src = b.cover || "";
  $("#edit-title").value = b.title;
  $("#edit-author").value = b.author || "";
  $("#edit-isbn").value = b.isbn || "";
  $("#edit-status").value = b.status;
  $("#edit-type").value = b.type;
  $("#edit-source").value = b.source || "owned";
  $("#edit-note").value = b.note || "";
  renderTagPicker("#edit-tag-picker", b.tags || []);
  $("#edit-dialog").showModal();
}
function commitEdit() {
  const i = state.books.findIndex((x) => x.id === state.editingId);
  if (i < 0) return;
  const b = state.books[i];
  b.title = $("#edit-title").value.trim() || b.title;
  b.author = $("#edit-author").value.trim();
  b.isbn = $("#edit-isbn").value.trim();
  b.status = $("#edit-status").value;
  b.type = $("#edit-type").value;
  b.source = $("#edit-source").value;
  b.note = $("#edit-note").value.trim();
  b.tags = getSelectedTags("#edit-tag-picker");
  saveBooks();
  state.editingId = null;
  $("#edit-dialog").close();
  render();
}
function deleteEditing() {
  if (!state.editingId) return;
  if (!confirm("確定要從書櫃刪除這本書嗎？")) return;
  state.books = state.books.filter((x) => x.id !== state.editingId);
  saveBooks();
  state.editingId = null;
  $("#edit-dialog").close();
  render();
}

/* ---------- Tag manager ---------- */
function openTagManager() {
  renderTagManager();
  $("#tag-manager-dialog").showModal();
}
function renderTagManager() {
  const box = $("#tag-list");
  if (state.tags.length === 0) {
    box.innerHTML = `<p class="hint">還沒有任何標籤。可在新增/編輯書籍時點「＋ 新增標籤」建立。</p>`;
  } else {
    const counts = {};
    state.books.forEach((b) => (b.tags || []).forEach((t) => counts[t] = (counts[t] || 0) + 1));
    box.innerHTML = state.tags.map((t) => `
      <div class="tag-row" data-tag="${escapeHtml(t)}">
        <span class="name">${escapeHtml(t)}</span>
        <span class="count">${counts[t] || 0} 本</span>
        <div class="actions">
          <button class="rename" type="button">改名</button>
          <button class="remove danger" type="button">刪除</button>
        </div>
      </div>
    `).join("");
    box.querySelectorAll(".tag-row").forEach((row) => {
      const name = row.dataset.tag;
      row.querySelector(".rename").addEventListener("click", () => {
        const next = (prompt(`將「${name}」改名為：`, name) || "").trim();
        if (!next || next === name) return;
        renameTag(name, next);
        renderTagManager();
        render();
      });
      row.querySelector(".remove").addEventListener("click", () => {
        if (!confirm(`確定刪除標籤「${name}」？\n所有書本上的此標籤會被移除（書本本身不會被刪除）。`)) return;
        deleteTag(name);
        renderTagManager();
        render();
      });
    });
  }
  const addBtn = $("#tag-manager-add");
  if (addBtn) {
    addBtn.onclick = () => {
      const name = (prompt("新標籤名稱：") || "").trim();
      if (!name) return;
      if (!state.tags.includes(name)) {
        state.tags.push(name);
        saveTags();
        renderTagManager();
        render();
      }
    };
  }
}
function renameTag(oldName, newName) {
  const idx = state.tags.indexOf(oldName);
  if (idx < 0) return;
  if (state.tags.includes(newName)) state.tags.splice(idx, 1);
  else state.tags[idx] = newName;
  state.books.forEach((b) => {
    if (!b.tags) return;
    b.tags = b.tags.map((t) => t === oldName ? newName : t)
      .filter((t, i, a) => a.indexOf(t) === i);
  });
  saveTags();
  saveBooks();
}
function deleteTag(name) {
  state.tags = state.tags.filter((t) => t !== name);
  state.books.forEach((b) => {
    if (b.tags) b.tags = b.tags.filter((t) => t !== name);
  });
  saveTags();
  saveBooks();
}

/* ---------- Scanner ---------- */
async function maybeAutoStartScanner() {
  if (state.scanner.running) return;
  if (!navigator.permissions || !navigator.permissions.query) return;
  try {
    const res = await navigator.permissions.query({ name: "camera" });
    if (res.state === "granted") {
      startScanner();
    }
  } catch {
    // Permissions API doesn't support 'camera' on this browser; user must press button
  }
}

async function startScanner() {
  if (state.scanner.running) return;
  const status = $("#scanner-status");
  const video = $("#scanner-video");

  if (!("BarcodeDetector" in window)) {
    status.textContent = "此瀏覽器不支援條碼掃描。請改用「搜尋」或下方手動輸入 ISBN。";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "無法取得相機。請改用「搜尋」分頁。";
    return;
  }
  try {
    state.scanner.detector = new BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e"]
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    state.scanner.stream = stream;
    video.srcObject = stream;
    await video.play();
    state.scanner.running = true;
    status.textContent = "請將書本封底的條碼對準框內";
    $("#scanner-start").classList.add("hidden");
    $("#scanner-stop").classList.remove("hidden");
    scanLoop();
  } catch (err) {
    console.error(err);
    status.textContent = "啟動相機失敗：" + (err.message || err.name || "未知錯誤");
  }
}
async function scanLoop() {
  const video = $("#scanner-video");
  if (!state.scanner.running) return;
  try {
    const codes = await state.scanner.detector.detect(video);
    if (codes && codes.length) {
      const raw = codes[0].rawValue || "";
      const isbn = normalizeIsbn(raw);
      if (isValidIsbn(isbn)) {
        $("#scanner-status").textContent = `偵測到 ISBN：${isbn}，查詢中…`;
        stopScanner();
        await lookupAndOpenConfirm(isbn);
        return;
      }
    }
  } catch {}
  state.scanner.rafId = requestAnimationFrame(scanLoop);
}
function stopScanner() {
  state.scanner.running = false;
  if (state.scanner.rafId) cancelAnimationFrame(state.scanner.rafId);
  if (state.scanner.stream) {
    state.scanner.stream.getTracks().forEach((t) => t.stop());
    state.scanner.stream = null;
  }
  $("#scanner-video").srcObject = null;
  $("#scanner-start").classList.remove("hidden");
  $("#scanner-stop").classList.add("hidden");
}
async function lookupAndOpenConfirm(isbn) {
  try {
    const items = await googleBooksByIsbn(isbn);
    if (items.length) {
      openConfirm(items[0]);
    } else {
      openConfirm({
        title: "（未知書名）",
        author: "", isbn, cover: "", publisher: "", publishedDate: ""
      });
    }
  } catch (err) {
    alert("查詢失敗：" + err.message);
  }
}

/* ---------- Backup / Restore ---------- */
function exportBackup() {
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    books: state.books,
    tags: state.tags
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `bookshelf-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert("無法讀取檔案，看起來不是有效的 JSON 備份。"); return; }
  const incoming = Array.isArray(data) ? data : data.books;
  if (!Array.isArray(incoming)) { alert("檔案格式不正確。"); return; }
  const valid = incoming.filter((b) => b && typeof b.title === "string");
  if (!valid.length) { alert("檔案中沒有任何有效的書籍資料。"); return; }
  if (Array.isArray(data.tags)) {
    data.tags.forEach((t) => {
      if (typeof t === "string" && t && !state.tags.includes(t)) state.tags.push(t);
    });
  }
  const keyOf = (b) => b.isbn ? `isbn:${b.isbn}` : `t:${b.title}|a:${b.author || ""}`;
  const seen = new Set(state.books.map(keyOf));
  let added = 0;
  for (const b of valid) {
    const k = keyOf(b);
    if (seen.has(k)) continue;
    seen.add(k);
    const tags = Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string") : [];
    tags.forEach((t) => { if (!state.tags.includes(t)) state.tags.push(t); });
    const validSource = ["owned", "library", "borrowed"];
    state.books.push({
      id: b.id || uid(),
      title: b.title,
      author: b.author || "",
      isbn: b.isbn || "",
      cover: b.cover || "",
      publisher: b.publisher || "",
      publishedDate: b.publishedDate || "",
      status: b.status === "read" ? "read" : "unread",
      type: b.type === "ebook" ? "ebook" : "physical",
      source: validSource.includes(b.source) ? b.source : "owned",
      note: b.note || "",
      tags,
      addedAt: typeof b.addedAt === "number" ? b.addedAt : Date.now()
    });
    added++;
  }
  saveBooks();
  saveTags();
  render();
  $("#menu-dialog").close();
  alert(`已匯入 ${added} 本新書（略過 ${valid.length - added} 本重複）。`);
}

/* ---------- Wire up ---------- */
function wireEvents() {
  $("#filter-status").addEventListener("change", (e) => { state.filter.status = e.target.value; render(); });
  $("#filter-type").addEventListener("change", (e) => { state.filter.type = e.target.value; render(); });
  $("#filter-source").addEventListener("change", (e) => { state.filter.source = e.target.value; render(); });
  $("#filter-tag").addEventListener("change", (e) => { state.filter.tag = e.target.value; render(); });
  $("#filter-search").addEventListener("input", (e) => { state.filter.search = e.target.value; render(); });

  $("#sort-by").value = state.settings.sortBy;
  $("#sort-by").addEventListener("change", (e) => {
    state.settings.sortBy = e.target.value;
    saveSettings();
    render();
  });
  $("#layout").value = state.settings.layout;
  $("#layout").addEventListener("change", (e) => {
    state.settings.layout = e.target.value;
    saveSettings();
    render();
  });

  $("#add-btn").addEventListener("click", openAddDialog);
  $("#close-add").addEventListener("click", closeAddDialog);
  $("#add-dialog").addEventListener("close", () => { stopScanner(); state.selectedSearch.clear(); });

  $$(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  $("#scanner-start").addEventListener("click", startScanner);
  $("#scanner-stop").addEventListener("click", stopScanner);

  $("#manual-isbn-btn").addEventListener("click", async () => {
    const v = normalizeIsbn($("#manual-isbn").value);
    if (!isValidIsbn(v)) {
      alert("ISBN 看起來不正確，請輸入 10 或 13 位數字。");
      return;
    }
    await lookupAndOpenConfirm(v);
  });

  $("#search-btn").addEventListener("click", runSearch);
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });

  $("#multi-add-confirm").addEventListener("click", openMultiConfirm);
  $("#multi-add-clear").addEventListener("click", () => {
    state.selectedSearch.clear();
    renderSearchResults();
    updateMultiAddBar();
  });

  $("#confirm-form").addEventListener("submit", (e) => { e.preventDefault(); commitNewBook(); });
  $("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close());

  $("#multi-confirm-form").addEventListener("submit", (e) => { e.preventDefault(); commitMultiBooks(); });
  $("#multi-confirm-cancel").addEventListener("click", () => $("#multi-confirm-dialog").close());

  $("#edit-form").addEventListener("submit", (e) => { e.preventDefault(); commitEdit(); });
  $("#edit-cancel").addEventListener("click", () => $("#edit-dialog").close());
  $("#edit-delete").addEventListener("click", deleteEditing);

  $("#menu-btn").addEventListener("click", () => $("#menu-dialog").showModal());
  $("#close-menu").addEventListener("click", () => $("#menu-dialog").close());
  $("#export-btn").addEventListener("click", exportBackup);
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importBackup(f);
    e.target.value = "";
  });
  $("#manage-tags-btn").addEventListener("click", () => {
    $("#menu-dialog").close();
    openTagManager();
  });
  $("#close-tag-manager").addEventListener("click", () => $("#tag-manager-dialog").close());
}

async function runSearch() {
  const q = $("#search-input").value.trim();
  if (!q) return;
  const box = $("#search-results");
  box.innerHTML = `<p class="hint">查詢中…</p>`;
  state.selectedSearch.clear();
  updateMultiAddBar();
  try {
    const items = await googleBooksSearch(q);
    showSearchResults(items);
  } catch (err) {
    box.innerHTML = `<p class="hint">查詢失敗：${escapeHtml(err.message)}</p>`;
  }
}

/* ---------- Boot ---------- */
ensureOpenCC();
wireEvents();
render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
