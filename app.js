"use strict";

const STORAGE_KEY = "myBookshelf.books.v1";
const TAGS_KEY = "myBookshelf.tags.v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  books: [],
  tags: [],
  filter: { status: "all", type: "all", tag: "all", search: "" },
  pendingBook: null,
  editingId: null,
  scanner: { stream: null, running: false, detector: null, rafId: null }
};

state.books = loadBooks();
state.tags = loadTags();

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
        } catch {
          openccConverter = null;
        }
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
async function googleBooksSearch(query) {
  await ensureOpenCC();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&country=TW`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("查詢失敗");
  const data = await r.json();
  return (data.items || []).map(toBookData);
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

/* ---------- Render ---------- */
function statusLabel(s) { return s === "read" ? "已讀" : "未讀"; }
function typeLabel(t) { return t === "ebook" ? "電子書" : "實體書"; }

function applyFilters(books) {
  const { status, type, tag, search } = state.filter;
  const q = search.trim().toLowerCase();
  return books.filter((b) => {
    if (status !== "all" && b.status !== status) return false;
    if (type !== "all" && b.type !== type) return false;
    if (tag !== "all") {
      const tags = b.tags || [];
      if (tag === "__none__") {
        if (tags.length) return false;
      } else if (!tags.includes(tag)) {
        return false;
      }
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
  const filtered = applyFilters(state.books)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

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
  return `
    <article class="book-card" data-id="${b.id}">
      ${coverHtml(b.cover)}
      <div class="meta">
        <p class="title">${escapeHtml(b.title)}</p>
        <p class="author">${escapeHtml(b.author || "（未知作者）")}</p>
        <div class="badges">
          <span class="badge ${b.status}">${statusLabel(b.status)}</span>
          <span class="badge ${b.type}">${typeLabel(b.type)}</span>
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
  switchTab("scan");
  $("#add-dialog").showModal();
}
function closeAddDialog() {
  stopScanner();
  $("#add-dialog").close();
}
function switchTab(name) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}

function showSearchResults(items) {
  const box = $("#search-results");
  if (!items.length) {
    box.innerHTML = `<p class="hint">找不到結果。可以試試別的關鍵字，或直接手動填寫。</p>`;
    return;
  }
  box.innerHTML = items.map((b, i) => `
    <div class="result-item" data-idx="${i}">
      ${coverHtml(b.cover)}
      <div class="meta">
        <strong>${escapeHtml(b.title)}</strong>
        <small>${escapeHtml(b.author || "")}${b.publishedDate ? " · " + escapeHtml(b.publishedDate) : ""}</small>
        ${b.isbn ? `<small>ISBN ${escapeHtml(b.isbn)}</small>` : ""}
      </div>
    </div>
  `).join("");
  box.querySelectorAll(".result-item").forEach((el) => {
    el.addEventListener("click", () => openConfirm(items[+el.dataset.idx]));
  });
}

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
    box.innerHTML = `<p class="hint">還沒有任何標籤。在新增/編輯書籍時會出現「＋ 新增標籤」按鈕。</p>`;
    return;
  }
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
  if (state.tags.includes(newName)) {
    state.tags.splice(idx, 1);
  } else {
    state.tags[idx] = newName;
  }
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
async function startScanner() {
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
        author: "",
        isbn,
        cover: "",
        publisher: "",
        publishedDate: ""
      });
    }
  } catch (err) {
    alert("查詢失敗：" + err.message);
  }
}

/* ---------- Backup / Restore ---------- */
function exportBackup() {
  const payload = {
    version: 2,
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
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("無法讀取檔案，看起來不是有效的 JSON 備份。");
    return;
  }
  const incoming = Array.isArray(data) ? data : data.books;
  if (!Array.isArray(incoming)) {
    alert("檔案格式不正確，找不到書籍資料。");
    return;
  }
  const valid = incoming.filter((b) => b && typeof b.title === "string");
  if (!valid.length) {
    alert("檔案中沒有任何有效的書籍資料。");
    return;
  }
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
  $("#filter-status").addEventListener("change", (e) => {
    state.filter.status = e.target.value; render();
  });
  $("#filter-type").addEventListener("change", (e) => {
    state.filter.type = e.target.value; render();
  });
  $("#filter-tag").addEventListener("change", (e) => {
    state.filter.tag = e.target.value; render();
  });
  $("#filter-search").addEventListener("input", (e) => {
    state.filter.search = e.target.value; render();
  });

  $("#add-btn").addEventListener("click", openAddDialog);
  $("#close-add").addEventListener("click", closeAddDialog);
  $("#add-dialog").addEventListener("close", stopScanner);

  $$(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => {
      switchTab(b.dataset.tab);
      if (b.dataset.tab !== "scan") stopScanner();
    })
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

  $("#confirm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    commitNewBook();
  });
  $("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close());

  $("#edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    commitEdit();
  });
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
