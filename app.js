"use strict";

const STORAGE_KEY = "myBookshelf.books.v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  books: loadBooks(),
  filter: { status: "all", type: "all", search: "" },
  pendingBook: null,
  editingId: null,
  scanner: { stream: null, running: false, detector: null, rafId: null }
};

/* ---------- Storage ---------- */
function loadBooks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function saveBooks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.books));
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

/* ---------- Google Books ---------- */
async function googleBooksSearch(query) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("查詢失敗");
  const data = await r.json();
  return (data.items || []).map(toBookData);
}
async function googleBooksByIsbn(isbn) {
  const items = await googleBooksSearch(`isbn:${isbn}`);
  if (items.length) return items;
  // 保險：有些 ISBN 在 isbn: 索引找不到，再用一般查詢試一次
  return googleBooksSearch(isbn);
}
function toBookData(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn13 = ids.find((x) => x.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((x) => x.type === "ISBN_10")?.identifier;
  const cover =
    v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "";
  return {
    title: v.title || "(無標題)",
    author: (v.authors || []).join(", "),
    isbn: isbn13 || isbn10 || "",
    cover: cover ? cover.replace(/^http:/, "https:") : "",
    publisher: v.publisher || "",
    publishedDate: v.publishedDate || ""
  };
}

/* ---------- Render ---------- */
function statusLabel(s) { return s === "read" ? "已讀" : "未讀"; }
function typeLabel(t)   { return t === "ebook" ? "電子書" : "實體書"; }

function applyFilters(books) {
  const { status, type, search } = state.filter;
  const q = search.trim().toLowerCase();
  return books.filter((b) => {
    if (status !== "all" && b.status !== status) return false;
    if (type !== "all" && b.type !== type) return false;
    if (q) {
      const hay = `${b.title} ${b.author} ${b.isbn}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const list = $("#book-list");
  const empty = $("#empty-hint");
  const filtered = applyFilters(state.books).sort(
    (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
  );

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

function bookCardHtml(b) {
  const cover = b.cover
    ? `<img src="${escapeHtml(b.cover)}" alt="" loading="lazy" />`
    : `<img alt="" />`;
  return `
    <article class="book-card" data-id="${b.id}">
      ${cover}
      <div class="meta">
        <p class="title">${escapeHtml(b.title)}</p>
        <p class="author">${escapeHtml(b.author || "（未知作者）")}</p>
        <div class="badges">
          <span class="badge ${b.status}">${statusLabel(b.status)}</span>
          <span class="badge ${b.type}">${typeLabel(b.type)}</span>
          ${b.isbn ? `<span class="badge">ISBN ${escapeHtml(b.isbn)}</span>` : ""}
        </div>
      </div>
    </article>
  `;
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
      ${b.cover ? `<img src="${escapeHtml(b.cover)}" alt="" />` : `<img alt="" />`}
      <div class="meta">
        <strong>${escapeHtml(b.title)}</strong>
        <small>${escapeHtml(b.author || "")} ${b.publishedDate ? "· " + escapeHtml(b.publishedDate) : ""}</small>
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
  $("#confirm-cover").src = book.cover || "";
  $("#confirm-title").textContent = book.title;
  $("#confirm-author").textContent = book.author || "（未知作者）";
  $("#confirm-isbn").textContent = book.isbn ? `ISBN ${book.isbn}` : "";
  $("#confirm-status").value = "unread";
  $("#confirm-type").value = "physical";
  $("#confirm-note").value = "";
  $("#confirm-dialog").showModal();
}

function commitNewBook() {
  const b = state.pendingBook;
  if (!b) return;
  const newBook = {
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
    addedAt: Date.now()
  };
  state.books.push(newBook);
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
  $("#edit-cover").src = b.cover || "";
  $("#edit-title").value = b.title;
  $("#edit-author").value = b.author || "";
  $("#edit-isbn").value = b.isbn || "";
  $("#edit-status").value = b.status;
  $("#edit-type").value = b.type;
  $("#edit-note").value = b.note || "";
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

/* ---------- Scanner ---------- */
async function startScanner() {
  const status = $("#scanner-status");
  const video = $("#scanner-video");

  if (!("BarcodeDetector" in window)) {
    status.textContent = "此瀏覽器不支援條碼掃描。請改用「搜尋」分頁，或下方手動輸入 ISBN。";
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
  } catch (err) {
    // ignore frame error
  }
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
      // 找不到，預填 ISBN 讓使用者手動補資料
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
    version: 1,
    exportedAt: new Date().toISOString(),
    books: state.books
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
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
    const text = await file.text();
    data = JSON.parse(text);
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

  const keyOf = (b) =>
    b.isbn ? `isbn:${b.isbn}` : `t:${b.title}|a:${b.author || ""}`;
  const seen = new Set(state.books.map(keyOf));
  let added = 0;
  for (const b of valid) {
    const k = keyOf(b);
    if (seen.has(k)) continue;
    seen.add(k);
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
      addedAt: typeof b.addedAt === "number" ? b.addedAt : Date.now()
    });
    added++;
  }
  saveBooks();
  render();
  $("#backup-dialog").close();
  alert(`已匯入 ${added} 本新書（略過 ${valid.length - added} 本重複）。`);
}

/* ---------- Wire up ---------- */
function wireEvents() {
  $("#filter-status").addEventListener("change", (e) => {
    state.filter.status = e.target.value;
    render();
  });
  $("#filter-type").addEventListener("change", (e) => {
    state.filter.type = e.target.value;
    render();
  });
  $("#filter-search").addEventListener("input", (e) => {
    state.filter.search = e.target.value;
    render();
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

  $("#menu-btn").addEventListener("click", () => $("#backup-dialog").showModal());
  $("#close-backup").addEventListener("click", () => $("#backup-dialog").close());
  $("#export-btn").addEventListener("click", exportBackup);
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importBackup(f);
    e.target.value = "";
  });
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
wireEvents();
render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
