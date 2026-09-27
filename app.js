/* Gift Catalog 2026 — 表示・操作・同期。
   カタログの中身（データ・写真・画面の文言）は暗号化して enc/ に置き、解錠後に start() へ渡される。
   このファイル自体は公開されるので、中身が分かる文言をここに書かない。
   共有データ（★・メモ）は Firebase の DB_PATH 以下に、1項目・1人ずつの細かい単位で書く。
   ノード全体を set しないので、片方の編集がもう片方の★やメモを巻き戻すことはない。 */
"use strict";

const DB_PATH = "gift-catalog-2026";
const LS_PREFIX = "gift-catalog-2026-";
const CACHE_KEY = LS_PREFIX + "cache";   // 共有データの表示用控え（オフラインでも★とメモを見られるように）
const UI_KEY = LS_PREFIX + "ui";         // タブ・絞り込み・表示切替など、この端末だけの設定
const WANT_MAX = 5;
/* ローカル確認用：この端末（localhost）で ?preview を付けたときだけ、ログインなしで閲覧できる。公開URLでは効かない。 */
const PREVIEW = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("preview");
const NOTE_MAX = 1000;

/* 価格帯の判定はコード側（ラベルは解錠後の文言から） */
const BAND_TEST = {
  lt15: p => p !== null && p < 15000,
  "15to30": p => p !== null && p >= 15000 && p < 30000,
  "30to40": p => p !== null && p >= 30000 && p < 40000,
  ge40: p => p !== null && p >= 40000,
  none: p => p === null
};
/* 解錠後に start() が入れる。ここには中身を書かない */
let DATA = null, COPY = {}, TABS = [], PRICE_BANDS = [], SORTS = [], TRYON_VARIANTS = [];
let ITEMS = [], BY_ID = {}, TRYON_MAP = {}, PRICE = {};
let started = false;

/* ---------- 小道具 ---------- */
const $ = sel => document.querySelector(sel);
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function readLS(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === "object" ? v : fallback; }
  catch (e) { return fallback; }
}
function writeLS(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できない環境でも表示は続ける */ } }

/* 解錠後の文言。無い場合も画面が壊れないよう、呼び出し側で既定値を渡す */
function L(key, fallback) { return (COPY.labels && COPY.labels[key]) || fallback || ""; }
function CAP(key, fallback) { return (COPY.captions && COPY.captions[key]) || fallback || ""; }

/* 画像は暗号化されているので、復号できたものから src に入れる。
   imageSrc は同期（復号済みなら URL、まだなら ""）。再描画のたびにちらつかせないための約束。 */
let imageSrc = () => "";
let requestImage = () => {};
function encImg(path, attrs) {
  const src = imageSrc(path);
  return `<img class="enc-img"${attrs || ""} data-enc="${esc(path)}"${src ? ` src="${esc(src)}"` : ""} loading="lazy">`;
}
/* 描画のたびに、まだ src の無い画像を復号待ちに登録する */
let imgObserver = null;
function hydrateImages(root) {
  const list = (root || document).querySelectorAll("img[data-enc]:not([src])");
  if (!list.length) return;
  if (typeof IntersectionObserver !== "function") { list.forEach(el => requestImage(el.dataset.enc, el)); return; }
  if (!imgObserver) {
    imgObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        imgObserver.unobserve(en.target);
        requestImage(en.target.dataset.enc, en.target);
      });
    }, { rootMargin: "400px" });
  }
  list.forEach(el => imgObserver.observe(el));
}

/* 表示用の価格（例「33,000円（公式取得）／38,500円」）から、比較用の最初の金額を取り出す。
   「2人1万〜2万円」のような人数表記は金額ではないので除く。金額が無ければ null。 */
function parsePrice(text) {
  const s = String(text || "").replace(/\d+人/g, "");
  const m = s.match(/(\d[\d,]*(?:\.\d+)?)\s*(万)?(?=\s*(?:円|万|〜|～))/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  // 「6.5〜7万円」のように単位が範囲の後ろにだけ付く書き方も万として読む
  const rangeMan = !m[2] && /^\s*[〜～]\s*\d[\d,.]*\s*万/.test(s.slice(m.index + m[0].length));
  return Math.round(m[2] || rangeMan ? n * 10000 : n);
}

/* ---------- 状態 ---------- */
const ui = Object.assign({ tab: "guide", check: [], band: [], use: [], starred: false, sort: "rec", view: "cards", tryon: "red", v: 3 }, readLS(UI_KEY, {}));
if (!(ui.v >= 3)) { ui.sort = "rec"; ui.check = []; delete ui.status; ui.v = 3; }   // 以前の端末に残った並び替え・評価の絞り込みを一度だけ揃える
let shared = { want: {}, note: {}, members: {} };   // 共有データ。閲覧専用では触らない
let myUid = "";
let myEmail = "";   // ログイン中のアカウントのメールアドレス（Firebase から受け取るだけで、ファイルには書かない）
let syncState = "offline";   // offline | connecting | live | denied
let unsubs = [];

function saveUI() { writeLS(UI_KEY, ui); }
function saveCache() { if (isOwner()) writeLS(CACHE_KEY, shared); }
/* 持ち主モード（Googleログイン済み）かどうか。閲覧専用では★もメモも出さない */
function isOwner() { return !!myUid && syncState !== "denied"; }

/* 表示名：公開ファイルにメールアドレスを書かないよう、"gc26:"+メールアドレス の SHA-256 で照合する（対応表は暗号化した文言の中） */
let myName = "";
async function resolveMyName(email) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gc26:" + email.toLowerCase()));
    return ((COPY.names || {})[[...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")]) || "";
  } catch (e) { return ""; }
}
/* 自分の表示名を members/{uid} に書いておき、相手の画面でも名前で出るようにする */
function syncMyName() {
  if (!myName || syncState !== "live" || (shared.members || {})[myUid] === myName) return;
  shared.members = Object.assign({}, shared.members, { [myUid]: myName });
  writeShared(`members/${myUid}`, myName);
}
function memberName(uid) {
  if (uid === myUid && myName) return myName;
  const n = shared.members && shared.members[uid];
  if (n) return String(n);
  return uid === myUid ? L("self", "自分") : L("partner", "相手");
}
/* ★をつけた人の一覧。自分を先頭にする */
function raters() {
  const ids = new Set(Object.keys(shared.want || {}));
  Object.keys(shared.members || {}).forEach(u => ids.add(u));
  if (myUid) ids.add(myUid);
  return [...ids].sort((a, b) => (a === myUid ? -1 : b === myUid ? 1 : a.localeCompare(b)));
}
function getWant(uid, id) {
  const v = parseInt(((shared.want || {})[uid] || {})[id], 10);
  return v >= 1 && v <= WANT_MAX ? v : 0;
}
function wantTotal(id) { return raters().reduce((s, u) => s + getWant(u, id), 0); }
function getNote(id) {
  const n = (shared.note || {})[id];
  return n && typeof n.text === "string" ? n : null;
}
function canEdit() { return !!myUid && syncState === "live"; }

/* ---------- 同期 ---------- */
function setStatus(text, kind) {
  ["#sync-status", "#gate-status"].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || "";
  });
}
/* 最初はログイン画面だけを見せ、許可されたアカウントで共有データを読めたらカタログを開く */
let unlocked = false;
let authKnown = false;   // Firebase がログイン状態を返すまでは、ログインボタンを出さずに「確認しています…」にする
function setLocked(locked) {
  const wasUnlocked = unlocked;
  unlocked = !locked;
  document.body.classList.toggle("locked", locked);
  $("#gate").hidden = !locked;
  $("#app").hidden = locked;
  if (unlocked && !wasUnlocked) { if (location.hash) routeFromHash(); else renderAll(); }
}
function refreshStatus() {
  if (started && !myUid) setStatus(L("guestBadge", "閲覧のみ"), "ok");
  else if (myUid && syncState === "live") setStatus(myEmail ? `${memberName(myUid)} (${myEmail})` : memberName(myUid), "ok");
  else if (myUid && syncState === "denied") setStatus("このアカウントでは開けません。招待されたアカウントでログインし直してください。", "error");
  else if (!gateReady) setStatus("確認しています…", "");
  else setStatus("ログインするか、合言葉を入れてください", "");
  setLocked(!started);
}
function stopSync() { unsubs.forEach(f => { try { f(); } catch (e) { /* 既に解除済み */ } }); unsubs = []; }
function onAuth(uid, email) {
  authKnown = true;
  myEmail = uid ? String(email || "") : "";
  myName = "";
  if (myEmail) resolveMyName(myEmail).then(n => {
    if (!n || uid !== myUid) return;
    myName = n;
    syncMyName();
    refreshStatus();
    refreshSocialAll();
  });
  document.body.classList.remove("auth-pending");
  stopSync();
  myUid = uid;
  syncState = uid ? "connecting" : "offline";
  if (uid) {
    try { localStorage.setItem(OWNER_FLAG, "1"); } catch (e) { /* 保存できなくても続ける */ }
    shared = Object.assign({ want: {}, note: {}, members: {} }, readLS(CACHE_KEY, {}));   // 控えは持ち主だけ
  } else {
    shared = { want: {}, note: {}, members: {} };
  }
  applyHeroCopy();
  refreshStatus();
  renderAll();
  if (!uid || !window.FB) return;
  const { db, ref, onValue } = window.FB;
  const pending = new Set(["want", "note", "members"]);
  // 中身の鍵は2人だけが読める。これで合言葉なしに開ける
  unsubs.push(onValue(ref(db, `${DB_PATH}/key`), snap => onContentKey(snap.val()),
    err => console.warn("鍵の読み取りに失敗", err && err.code)));
  ["want", "note", "members"].forEach(key => {
    unsubs.push(onValue(ref(db, `${DB_PATH}/${key}`), snap => {
      shared[key] = snap.val() || {};
      pending.delete(key);
      if (!pending.size) syncState = "live";
      saveCache();
      syncMyName();
      refreshStatus();
      refreshSocialAll();
    }, err => {
      syncState = "denied";   // 許可されていないアカウント。閲覧専用として扱う
      applyHeroCopy();
      refreshStatus();
      renderAll();
      console.warn("Firebase 読み取り失敗", key, err && err.code);
    }));
  });
}
function writeShared(path, value) {
  if (!canEdit()) { setStatus("編集するにはGoogleでログインしてください", "error"); return Promise.resolve(false); }
  const { db, ref, set } = window.FB;
  return set(ref(db, `${DB_PATH}/${path}`), value).then(() => true, err => {
    setStatus("保存できませんでした。通信状態を確認して、もう一度お試しください。", "error");
    console.warn("Firebase 書き込み失敗", path, err && err.code);
    return false;
  });
}
function setWant(id, n) {
  if (!canEdit() || !BY_ID[id]) return;
  const v = getWant(myUid, id) === n ? 0 : n;   // 同じ★をもう一度押すと取り消し
  shared.want[myUid] = Object.assign({}, shared.want[myUid], { [id]: v || null });
  refreshSocial(id);
  writeShared(`want/${myUid}/${id}`, v || null);
}
/* 自分の★を消す（相手の★には触れない）。書き込みは1項目ずつ */
function clearWant(id) {
  if (!canEdit() || !getWant(myUid, id)) return;
  shared.want[myUid] = Object.assign({}, shared.want[myUid], { [id]: null });
  refreshSocial(id);
  writeShared(`want/${myUid}/${id}`, null);
}
function clearAllMyWants() {
  if (!canEdit()) return;
  // カタログから外した商品に残っている★も含めて消す
  const ids = Object.keys((shared.want || {})[myUid] || {}).filter(id => shared.want[myUid][id]);
  if (!ids.length || !confirm(`自分がつけた★（${ids.length}件）をすべて消しますか？相手の★は消えません。`)) return;
  shared.want[myUid] = {};
  saveCache();
  refreshSocialAll();
  ids.forEach(id => writeShared(`want/${myUid}/${id}`, null));
}
/* メモを書いている間の取り違えを防ぐ：書き始めた時点の内容を覚えておく */
let noteEdit = null;
function noteSnapshot(id) { const n = getNote(id); return { id, text: n ? n.text : "", at: n ? n.at : 0, uid: n ? n.uid : "" }; }
function beginNote(id, el) { noteEdit = Object.assign(noteSnapshot(id), { el: el || null }); }
/* 書いている途中に相手が更新したかどうか */
function noteChangedByOther(id) {
  if (!noteEdit || noteEdit.id !== id) return false;
  const n = getNote(id);
  return (n ? n.text : "") !== noteEdit.text && (!n || n.uid !== myUid);
}
function endNote(id, text, el) {
  const t = String(text || "").slice(0, NOTE_MAX);
  const started = noteEdit && noteEdit.id === id && (!el || !noteEdit.el || noteEdit.el === el) ? noteEdit : null;
  noteEdit = null;
  // 書き始めの記録が無いときは保存しない（古い内容で相手の更新を上書きしないため）
  if (!started) { refreshSocial(id); return; }
  // 自分が書き換えていないなら、何も保存しない
  if (t === started.text) { refreshSocial(id); return; }
  if (noteChangedByOtherSnapshot(started, id)) {
    if (!confirm("このメモは、書いている間に相手が更新しました。自分の内容で上書きしますか？\n（キャンセルすると相手の内容に戻します）")) { refreshSocial(id); return; }
  }
  setNote(id, t);
}
function noteChangedByOtherSnapshot(started, id) {
  if (!started) return false;
  const n = getNote(id);
  return (n ? n.text : "") !== started.text && (!n || n.uid !== myUid);
}
function setNote(id, text) {
  if (!canEdit() || !BY_ID[id]) return;
  const t = String(text || "").slice(0, NOTE_MAX);
  const cur = getNote(id);
  if ((cur ? cur.text : "") === t) return;
  const value = t ? { text: t, uid: myUid, at: Date.now() } : null;
  shared.note[id] = value;
  writeShared(`note/${id}`, value);
}
function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(OWNER_FLAG); } catch (e) { /* 無視 */ }
  forgetKey();
}

/* ---------- 描画：タブ ---------- */
function tabCount(key) {
  if (key === "fav") return ITEMS.filter(it => wantTotal(it.id) > 0).length;
  const n = ITEMS.filter(it => it.cat === key).length;
  return n || "";
}
function visibleTabs() { return TABS.filter(t => t.panel !== "fav" || isOwner()); }
function renderTabs() {
  $("#tabs").innerHTML = visibleTabs().map(t => {
    const c = tabCount(t.key);
    return `<button type="button" role="tab" class="tab${ui.tab === t.key ? " active" : ""}" data-tab="${t.key}" aria-selected="${ui.tab === t.key}">${esc(t.label)}${c !== "" && t.key !== "guide" && t.key !== "appendix" ? `<span class="tab-count">${c}</span>` : ""}</button>`;
  }).join("");
}
function clearFilters() { ui.check = []; ui.band = []; ui.use = []; ui.starred = false; }
/* この章に無い絞り込み条件は、画面に出ないまま0件の原因になるので外す */
function pruneFilters() {
  const here = ITEMS.filter(it => it.cat === ui.tab);
  if (!here.length) return;
  ui.check = ui.check.filter(c => here.some(it => it.check === c));
  ui.band = ui.band.filter(k => here.some(it => (PRICE_BANDS.find(b => b.key === k) || { test: () => false }).test(PRICE[it.id])));
  ui.use = ui.use.filter(u => here.some(it => (it.use || []).includes(u)));
}
function showTab(key, scrollId) {
  if (!visibleTabs().some(t => t.key === key)) key = "guide";
  ui.tab = key; pruneFilters(); saveUI();
  renderAll();
  if (scrollId) {
    const el = document.getElementById("item-" + scrollId);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
  } else window.scrollTo({ top: 0 });
}

/* ---------- 描画：カード ---------- */
function checkBadge(it) { return it.check ? `<span class="badge check">${esc(L("checkPrefix", "確認："))}${esc(it.check)}</span>` : ""; }
function rankBadge(it) { return it.rank ? `<span class="badge rank${it.rank <= 3 ? " top" : ""}">${esc(L("rankPrefix", "おすすめ "))}${it.rank}${esc(L("rankSuffix", "位"))}</span>` : ""; }
function galleryImages(it) {
  const list = [];
  if (it.images.item) list.push({ src: it.images.item, cap: `${it.id} ${it.itemLabel || CAP("item", "商品単体")}`, kind: "item" });
  if (it.images.wear) list.push({ src: it.images.wear, cap: `${it.id} ${it.wearLabel || CAP("wear", "人物の着用・使用例")}`, kind: "wear" });
  const t = TRYON_MAP[it.id] || {};
  TRYON_VARIANTS.forEach(v => { if (t[v.key]) list.push({ src: t[v.key], cap: `${it.id} ${CAP("tryon", "AI装着イメージ")}（${v.label}）・${CAP("tryonNote", "生成イメージ・実物とは異なります")}`, kind: "tryon-" + v.key }); });
  return list;
}
function tryonFigure(it) {
  if (it.cat !== "hair") return "";
  const t = TRYON_MAP[it.id];
  if (!t || !t[ui.tryon]) {
    const why = it.images.item ? CAP("tryonPending", "準備中") : CAP("tryonNoPhoto", "");
    return `<figure class="ph tryon-ph"><div class="ph-box">${esc(CAP("tryon", "AI装着イメージ"))}<br><small>${esc(why)}</small></div></figure>`;
  }
  const seg = TRYON_VARIANTS.map(v => `<button type="button" class="seg-btn${ui.tryon === v.key ? " on" : ""}" data-tryon="${v.key}" ${t[v.key] ? "" : "disabled"}>${esc(v.label)}</button>`).join("");
  return `<figure class="tryon">
    <button type="button" class="img-btn" data-lb="${it.id}" data-kind="tryon-${ui.tryon}">${encImg(t[ui.tryon], ` alt="${esc(it.name)}${esc(CAP("tryonAlt", ""))}"`)}</button>
    <div class="seg" role="group" aria-label="${esc(CAP("tryonVariantLabel", ""))}">${seg}</div>
    <figcaption><span class="ai-tag">AI</span>${esc(CAP("tryonNote", ""))}</figcaption></figure>`;
}
function gallery(it) {
  const figs = [];
  if (it.images.item) figs.push(`<figure><button type="button" class="img-btn" data-lb="${it.id}" data-kind="item">${encImg(it.images.item, ` data-fit="contain" alt="${esc(it.name)}"`)}</button><figcaption>${esc(it.itemLabel || CAP("item", "商品単体"))}</figcaption></figure>`);
  if (it.images.wear) figs.push(`<figure><button type="button" class="img-btn" data-lb="${it.id}" data-kind="wear">${encImg(it.images.wear, ` alt="${esc(it.name)}${esc(CAP("wearAlt", ""))}"`)}</button><figcaption>${esc(it.wearLabel || CAP("wear", "人物の着用・使用例"))}</figcaption></figure>`);
  else if (it.images.item && !it.hasWearPhoto) figs.push(`<figure class="ph"><div class="ph-box">${esc(CAP("wearMissing", ""))}<br><small>${esc(CAP("wearMissingNote", ""))}</small></div></figure>`);
  const tf = tryonFigure(it);
  if (tf) figs.push(tf);
  if (!figs.length) return "";
  return `<div class="gallery g${figs.length}">${figs.join("")}</div>`;
}
function starsHTML(id) {
  const rows = raters();
  if (!rows.length) return `<p class="muted small">${esc(L("wantLocked", ""))}</p>`;
  return rows.map(u => {
    const mine = u === myUid;
    const n = getWant(u, id);
    const stars = Array.from({ length: WANT_MAX }, (_, i) => {
      const on = i < n;
      return mine
        ? `<button type="button" class="star${on ? " on" : ""}" data-want="${i + 1}" aria-label="★${i + 1}" ${canEdit() ? "" : "disabled"}>★</button>`
        : `<span class="star${on ? " on" : ""}" aria-hidden="true">★</span>`;
    }).join("");
    const clear = mine && n && canEdit() ? `<button type="button" class="want-clear" data-want-clear aria-label="${esc(L("wantClearAll", ""))}">${esc(L("wantClear", "クリア"))}</button>` : "";
    return `<div class="want-row${mine ? " mine" : ""}"><span class="who">${esc(memberName(u))}</span><span class="stars" ${mine ? "" : `aria-label="★${n}"`}>${stars}</span>${clear}</div>`;
  }).join("");
}
function noteMeta(id) {
  const n = getNote(id);
  if (!n) return "";
  const d = new Date(n.at || 0);
  const when = isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${esc(L("noteMetaPrefix", ""))}${esc(memberName(n.uid))} ${when}`;
}
function socialHTML(it) {
  const n = getNote(it.id);
  return `<div class="want">${starsHTML(it.id)}</div>
    <label class="note"><span class="note-label">${esc(L("noteLabel", ""))}</span>
      <textarea data-note="${it.id}" rows="2" maxlength="${NOTE_MAX}" placeholder="${esc(canEdit() ? L("notePlaceholder", "") : L("notePlaceholderLocked", ""))}" ${canEdit() ? "" : "readonly"}>${esc(n ? n.text : "")}</textarea>
      <span class="note-meta">${noteMeta(it.id)}</span></label>`;
}
function cardHTML(it) {
  const notes = (it.notes || []).map(t => `<li>${esc(t)}</li>`).join("");
  const rows = [[L("features", ""), it.features], [L("reason", ""), it.reason], [L("caution", ""), it.caution]]
    .filter(r => r[1]).map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join("");
  const links = (it.links || []).map(l => `<a class="pill" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join("");
  return `<article class="card" id="item-${it.id}" data-id="${it.id}">
    <header class="card-head">
      <div class="card-meta"><span class="card-id">${it.id}</span><span class="brand">${esc(it.brand)}</span>${rankBadge(it)}${checkBadge(it)}</div>
      <h3>${esc(it.name)}</h3>
      ${it.model ? `<p class="model">${esc(L("modelPrefix", ""))}${esc(it.model)}</p>` : ""}
      <p class="price">${esc(it.price)}<small>${esc(it.priceNote)}</small></p>
    </header>
    ${gallery(it)}
    ${notes ? `<ul class="notes">${notes}</ul>` : ""}
    <dl class="desc">${rows}</dl>
    ${(it.use || []).length ? `<p class="uses">${it.use.map(u => `<span class="chip-s">${esc(u)}</span>`).join("")}</p>` : ""}
    ${links ? `<p class="links">${links}</p>` : ""}
    ${isOwner() ? `<div class="social" data-social="${it.id}">${socialHTML(it)}</div>` : ""}
  </article>`;
}

/* ---------- 絞り込み・並び替え ---------- */
function itemsOfTab() { return ITEMS.filter(it => it.cat === ui.tab); }
function applyFilters(list) {
  return list.filter(it =>
    (!ui.check.length || ui.check.includes(it.check)) &&
    (!ui.band.length || PRICE_BANDS.some(b => ui.band.includes(b.key) && b.test(PRICE[it.id]))) &&
    (!ui.use.length || (it.use || []).some(u => ui.use.includes(u))) &&
    (!ui.starred || wantTotal(it.id) > 0));
}
function sortItems(list, key) {
  const idx = id => ITEMS.findIndex(it => it.id === id);
  const price = (id, dir) => PRICE[id] === null ? Infinity : dir * PRICE[id];
  const cmp = {
    id: (a, b) => idx(a.id) - idx(b.id),
    rec: (a, b) => (a.rank || Infinity) - (b.rank || Infinity) || idx(a.id) - idx(b.id),
    priceAsc: (a, b) => price(a.id, 1) - price(b.id, 1) || idx(a.id) - idx(b.id),
    priceDesc: (a, b) => price(a.id, -1) - price(b.id, -1) || idx(a.id) - idx(b.id),
    want: (a, b) => wantTotal(b.id) - wantTotal(a.id) || idx(a.id) - idx(b.id)
  }[key] || (() => 0);
  return [...list].sort(cmp);
}
function chip(group, value, label, on, count) {
  return `<button type="button" class="chip${on ? " on" : ""}" data-filter="${group}" data-value="${esc(value)}">${esc(label)}${count !== undefined ? `<span class="chip-n">${count}</span>` : ""}</button>`;
}
function renderToolbar(all) {
  const checks = [...new Set(all.map(it => it.check).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const bands = PRICE_BANDS.filter(b => all.some(it => b.test(PRICE[it.id])));
  const uses = [...new Set(all.flatMap(it => it.use || []))];
  const group = (title, html) => html ? `<div class="tool-row"><span class="tool-label">${esc(title)}</span><div class="chips">${html}</div></div>` : "";
  const sorts = SORTS.filter(x => x.key !== "want" || isOwner());
  const tryonSwitch = ui.tab === "hair" ? `<div class="tool-row"><span class="tool-label">${esc(CAP("tryonSwitchLabel", ""))}</span><div class="seg big">${TRYON_VARIANTS.map(v => `<button type="button" class="seg-btn${ui.tryon === v.key ? " on" : ""}" data-tryon="${v.key}">${esc(v.label)}</button>`).join("")}</div></div>` : "";
  $("#toolbar").innerHTML = `
    ${tryonSwitch}
    ${checks.length > 1 ? group(L("filterCheck", "確認"), checks.map(c => chip("check", c, c, ui.check.includes(c), all.filter(it => it.check === c).length)).join("")) : ""}
    ${group(L("filterPrice", "価格"), bands.map(b => chip("band", b.key, b.label, ui.band.includes(b.key), all.filter(it => b.test(PRICE[it.id])).length)).join(""))}
    ${uses.length > 1 ? group(L("filterUse", "用途"), uses.map(u => chip("use", u, u, ui.use.includes(u))).join("")) : ""}
    <div class="tool-row tool-end">
      ${isOwner() ? chip("starred", "1", L("starredChip", ""), ui.starred) : ""}
      <label class="sort">${esc(L("sortLabel", ""))} <select id="sort">${sorts.map(x => `<option value="${x.key}"${ui.sort === x.key ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>
      <div class="seg"><button type="button" class="seg-btn${ui.view === "cards" ? " on" : ""}" data-view="cards">${esc(L("viewCards", ""))}</button><button type="button" class="seg-btn${ui.view === "table" ? " on" : ""}" data-view="table">${esc(L("viewTable", ""))}</button></div>
      ${ui.check.length || ui.band.length || ui.use.length || ui.starred ? `<button type="button" class="pill small" id="clear-filters">${esc(L("clearFilters", ""))}</button>` : ""}
    </div>`;
}
function tableHTML(list) {
  const rs = isOwner() ? raters() : [];
  const ranked = list.some(it => it.rank);
  const suffix = esc(L("rankSuffix", "位"));
  return `<div class="table-wrap"><table class="cmp"><thead><tr>${ranked ? `<th>${esc(L("tableRank", ""))}</th>` : ""}<th>${esc(L("tableId", "ID"))}</th><th>${esc(L("tableName", ""))}</th><th>${esc(L("tablePrice", ""))}</th><th>${esc(L("tableCheck", ""))}</th><th>${esc(L("tableUse", ""))}</th>${rs.map(u => `<th>★${esc(memberName(u))}</th>`).join("")}${isOwner() ? `<th>${esc(L("tableNote", ""))}</th>` : ""}</tr></thead><tbody>
    ${list.map(it => `<tr data-goto="${it.id}" tabindex="0">${ranked ? `<td class="nowrap">${it.rank ? it.rank + suffix : "—"}</td>` : ""}<td class="mono">${it.id}</td><td><span class="muted small">${esc(it.brand)}</span><br>${esc(it.name)}</td><td class="nowrap">${esc(it.price)}</td><td class="small">${esc(it.check || "")}</td><td class="small">${esc((it.use || []).join("・"))}</td>${rs.map(u => `<td class="stars-cell">${"★".repeat(getWant(u, it.id)) || "—"}</td>`).join("")}${isOwner() ? `<td class="small">${esc((getNote(it.id) || {}).text || "").slice(0, 40)}</td>` : ""}</tr>`).join("")}
  </tbody></table></div>`;
}
function binocularCompare() {
  const rows = DATA.binocularCompare;
  if (!rows || !rows.length) return "";
  return `<div class="compare-box"><h3>${esc(rows[0][0])}</h3><div class="table-wrap"><table class="cmp"><thead><tr>${rows[0].map((c, i) => `<th>${i ? esc(c) : ""}</th>`).join("")}</tr></thead><tbody>
    ${rows.slice(1).map(r => `<tr>${r.map((c, i) => i ? `<td>${r[0] === "ID" ? `<a href="#${esc(c)}" data-jump="${esc(c)}">${esc(c)}</a>` : esc(c)}</td>` : `<th>${esc(c)}</th>`).join("")}</tr>`).join("")}
  </tbody></table></div></div>`;
}
function renderItems() {
  const sec = DATA.sections[ui.tab] || {};
  $("#section-head").innerHTML = `<p class="kicker">${esc(sec.kicker || "")}</p><h2>${esc(sec.title || "")}</h2>${(sec.lead || []).map(p => `<p class="lead">${esc(p)}</p>`).join("")}`;
  const all = itemsOfTab();
  renderToolbar(all);
  $("#extra").innerHTML = ui.tab === "binocular" ? binocularCompare() : "";
  const list = sortItems(applyFilters(all), ui.sort);
  const empty = `<p class="empty">${esc(L("empty", ""))}</p>`;
  $("#cards").className = ui.view === "table" ? "" : "cards";
  $("#cards").innerHTML = !list.length ? empty : ui.view === "table" ? tableHTML(list) : list.map(cardHTML).join("");
}
function renderFav() {
  const list = sortItems(ITEMS.filter(it => wantTotal(it.id) > 0), "want");
  const mineCount = Object.values((shared.want || {})[myUid] || {}).filter(Boolean).length;
  const clearAll = canEdit() && mineCount ? `<p class="fav-actions"><button type="button" class="want-clear" id="clear-my-wants">${esc(L("wantClearAll", ""))}（${mineCount}件）</button></p>` : "";
  $("#fav-content").innerHTML = clearAll + (list.length ? tableHTML(list)
    : `<p class="empty">${esc(L("favEmpty", ""))}</p>`);
}
function renderGuideCopy() {
  const g = COPY.guide || {};
  const box = $("#guide-copy");
  if (!box) return;
  const items = (g.items || []).filter(x => !x.owner || isOwner())
    .map(x => `<dt${x.cls ? ` class="${esc(x.cls)}"` : ""}>${esc(x.t)}</dt><dd>${x.d || ""}</dd>`).join("");
  box.innerHTML = `${g.title ? `<h2>${esc(g.title)}</h2>` : ""}${g.intro ? `<p>${esc(g.intro)}</p>` : ""}${items ? `<dl class="guide-list">${items}</dl>` : ""}`;
}
function renderGuide() {
  renderGuideCopy();
  // おすすめ順のある章は上位5点ずつ。無ければ本命・有力
  const groups = (DATA.rankings || []).map(g => ({ title: (DATA.sections[g.cat] || {}).title || g.cat, list: sortItems(ITEMS.filter(it => it.cat === g.cat && it.rank), "rec").slice(0, 5) })).filter(g => g.list.length);
  const blocks = groups.length ? groups : [{ title: "", list: ITEMS.slice(0, 5) }];
  $("#guide-shortlist").innerHTML = blocks.map(g => `<h3>${g.title ? esc(g.title) + esc(L("guideTop", "")) + g.list.length : esc(L("guideFallback", ""))}</h3><div class="mini-list">${g.list.map(it => {
    const t = TRYON_MAP[it.id] || {};
    const img = t[ui.tryon] || it.images.item || "";
    return `<a class="mini" href="#${it.id}" data-jump="${it.id}">${img ? encImg(img, ` alt=""`) : ""}<span>${rankBadge(it)} <b>${it.id}</b> ${esc(it.name)}<br><small>${esc(it.brand)}・${esc(it.price)}</small></span></a>`;
  }).join("")}</div>`).join("");
}
function renderAppendix() {
  const isHeading = t => t.length <= 28 && !/[。．]$/.test(t) && !/^\d/.test(t);
  $("#appendix-content").innerHTML = (DATA.appendix || []).map((a, i) => `
    <section class="appendix"><p class="kicker">${esc(a.label)}</p><h2>${esc(a.title)}</h2>
      ${i === DATA.appendix.length - 1 && (COPY.guide || {}).appendixNotice ? `<p class="notice">${esc(COPY.guide.appendixNotice)}</p>` : ""}
      ${a.paras.map(p => isHeading(p) ? `<h4>${esc(p)}</h4>` : `<p>${esc(p)}</p>`).join("")}
    </section>`).join("");
}
function renderAll() {
  if (!started) return;
  renderTabs();
  const tabs = visibleTabs();
  const panel = (tabs.find(t => t.key === ui.tab) || tabs[0] || { panel: "guide" }).panel;
  document.querySelectorAll(".panel").forEach(p => { p.hidden = p.dataset.panel !== panel; });
  // 表示していない面に古い内容を残さない（閲覧専用に切り替わったときに★が残るのを防ぐ）
  if (panel !== "items" && $("#cards")) $("#cards").innerHTML = "";
  if (panel !== "fav" && $("#fav-content")) $("#fav-content").innerHTML = "";
  if (panel === "guide") renderGuide();
  else if (panel === "items") renderItems();
  else if (panel === "fav") renderFav();
  else if (panel === "appendix") renderAppendix();
  hydrateImages();
}
/* 共有データが変わったときは、入力中のメモを壊さないよう該当部分だけ差し替える */
function refreshSocial(id) {
  const box = document.querySelector(`[data-social="${id}"]`);
  if (!box) return;
  const ta = box.querySelector("textarea");
  if (ta && document.activeElement === ta) {
    // 入力中は本文を差し替えず、相手が更新したことだけ知らせる
    box.querySelector(".want").innerHTML = starsHTML(id);
    const meta = box.querySelector(".note-meta");
    if (meta) meta.innerHTML = noteChangedByOther(id) ? `<span class="warn">相手がこのメモを更新しました（保存時に確認します）</span>` : noteMeta(id);
    return;
  }
  box.innerHTML = socialHTML(BY_ID[id]);
}
function refreshSocialAll() {
  renderTabs();
  if (ui.tab === "fav") renderFav();
  else if (ui.view === "table" || ui.sort === "want" || ui.starred) {
    if (!document.activeElement || !document.activeElement.matches("textarea")) renderAll();
  } else ITEMS.forEach(it => { if (it.cat === ui.tab) refreshSocial(it.id); });
}

/* ---------- ライトボックス ---------- */
const lb = { list: [], i: 0 };
function openLightbox(id, kind) {
  lb.list = galleryImages(BY_ID[id]);
  lb.i = Math.max(0, lb.list.findIndex(x => x.kind === kind));
  showLightbox();
  $("#lightbox").classList.remove("hidden");
  $("#lightbox").setAttribute("aria-hidden", "false");
}
function showLightbox() {
  const cur = lb.list[lb.i];
  if (!cur) return;
  $("#lb-img").src = cur.src;
  $("#lb-cap").textContent = `${cur.cap}（${lb.i + 1}/${lb.list.length}）`;
}
function closeLightbox() { $("#lightbox").classList.add("hidden"); $("#lightbox").setAttribute("aria-hidden", "true"); }
function stepLightbox(d) { if (!lb.list.length) return; lb.i = (lb.i + d + lb.list.length) % lb.list.length; showLightbox(); }

/* ---------- イベント ---------- */
function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
function jumpTo(id) {
  const it = BY_ID[id];
  if (!it) return;
  if (ui.view !== "cards") { ui.view = "cards"; saveUI(); }   // 一覧表から飛んでもカードが開くように
  showTab(it.cat, id);
}
function bind() {
  document.addEventListener("click", e => {
    const t = e.target.closest("button, a, tr[data-goto]");
    if (!t) return;
    if (t.dataset.tab) { history.replaceState(null, "", "#" + t.dataset.tab); showTab(t.dataset.tab); return; }
    if (t.dataset.jump) { e.preventDefault(); history.replaceState(null, "", "#" + t.dataset.jump); jumpTo(t.dataset.jump); return; }
    if (t.dataset.goto) { history.replaceState(null, "", "#" + t.dataset.goto); jumpTo(t.dataset.goto); return; }
    if (t.dataset.lb) { openLightbox(t.dataset.lb, t.dataset.kind); return; }
    if (t.dataset.tryon) { ui.tryon = t.dataset.tryon; saveUI(); renderAll(); return; }
    if (t.dataset.view) { ui.view = t.dataset.view; saveUI(); renderItems(); return; }
    if (t.dataset.wantClear !== undefined) { const card = t.closest("[data-id]"); if (card) clearWant(card.dataset.id); return; }
    if (t.id === "clear-my-wants") { clearAllMyWants(); return; }
    if (t.dataset.want) { const card = t.closest("[data-id]"); if (card) setWant(card.dataset.id, parseInt(t.dataset.want, 10)); return; }
    if (t.dataset.filter) {
      const g = t.dataset.filter;
      if (g === "starred") ui.starred = !ui.starred; else toggleIn(ui[g], t.dataset.value);
      saveUI(); renderItems(); return;
    }
    if (t.id === "clear-filters") { clearFilters(); saveUI(); renderItems(); return; }
    if (t.id === "lb-close") closeLightbox();
    if (t.id === "lb-prev") stepLightbox(-1);
    if (t.id === "lb-next") stepLightbox(1);
  });
  document.addEventListener("keydown", e => {
    if (!$("#lightbox").classList.contains("hidden")) {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    } else if (e.key === "Enter" && e.target.matches("tr[data-goto]")) jumpTo(e.target.dataset.goto);
  });
  $("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("change", e => {
    if (e.target.id === "sort") { ui.sort = e.target.value; saveUI(); renderItems(); }
  });
  // メモはフォーカスが外れたときに保存（1文字ごとに送らない）
  document.addEventListener("focusin", e => {
    const ta = e.target.closest && e.target.closest("textarea[data-note]");
    if (ta && !ta.readOnly) beginNote(ta.dataset.note, ta);
  });
  document.addEventListener("focusout", e => {
    const ta = e.target.closest && e.target.closest("textarea[data-note]");
    if (!ta || ta.readOnly) return;
    endNote(ta.dataset.note, ta.value, ta);
    const meta = ta.parentElement && ta.parentElement.querySelector(".note-meta");
    if (meta) meta.innerHTML = noteMeta(ta.dataset.note);
  });
  window.addEventListener("hashchange", routeFromHash);
}
function routeFromHash() {
  if (!started) return;
  const h = decodeURIComponent(location.hash.slice(1));
  if (BY_ID[h]) jumpTo(h);
  else if (visibleTabs().some(t => t.key === h)) showTab(h);
}

/* ---------- 解錠（合言葉 / 2人の鍵 / 端末の記憶） ---------- */
const IDB_NAME = LS_PREFIX + "key";
const OWNER_FLAG = LS_PREFIX + "owner";
let gateReady = false;      // 入口の準備ができた（ボタンと合言葉欄を出してよい）
let keys = null;            // enc/keys.json
let subkeys = null;         // { kEnc, kId }
let manifest = null;

/* 復号済みの画像を URL にして持っておく（合計16MBまで。古いものから捨てる） */
const imgCache = new Map();
let imgBytes = 0;
const IMG_BUDGET = 16 * 1024 * 1024;
const inflight = new Map();
function cacheImage(path, url, size) {
  imgCache.set(path, { url, size });
  imgBytes += size;
  while (imgBytes > IMG_BUDGET && imgCache.size > 1) {
    const [oldPath, v] = imgCache.entries().next().value;
    if (oldPath === path) break;
    imgCache.delete(oldPath);
    imgBytes -= v.size;
    try { URL.revokeObjectURL(v.url); } catch (e) { /* 解放できなくても続ける */ }
    document.querySelectorAll(`img[data-enc="${CSS && CSS.escape ? CSS.escape(oldPath) : oldPath}"]`).forEach(el => el.removeAttribute("src"));
  }
}
async function decryptImage(path) {
  const f = manifest && manifest.files && manifest.files[path];
  if (!f || !subkeys) return "";
  const res = await fetch(`enc/b/${f.n}.bin?h=${f.h}`, { cache: "force-cache" });
  if (!res.ok) throw new Error("画像を取得できません");
  const plain = await GC.open(subkeys.kEnc, new Uint8Array(await res.arrayBuffer()), path);
  const url = URL.createObjectURL(new Blob([plain], { type: f.t || "application/octet-stream" }));
  cacheImage(path, url, plain.length);
  return url;
}
function installImageResolver() {
  imageSrc = path => (imgCache.get(path) || {}).url || "";
  requestImage = (path, el) => {
    const hit = imgCache.get(path);
    if (hit) { if (el) el.src = hit.url; return; }
    let job = inflight.get(path);
    if (!job) {
      job = decryptImage(path).catch(() => "").finally(() => inflight.delete(path));
      inflight.set(path, job);
    }
    job.then(url => { if (url && el && el.isConnected) el.src = url; });
  };
}

/* 端末の記憶：合言葉も鍵の中身も保存せず、「復号だけできる鍵」を置く */
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("k"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbRun(mode, fn) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction("k", mode);
    const req = fn(tx.objectStore("k"));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}
async function rememberKey(k) {
  try {
    const key = await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["decrypt"]);
    await idbRun("readwrite", st => st.put({ key, v: 1 }, "content"));
    return true;
  } catch (e) { return false; }
}
async function rememberedKey() {
  try { const rec = await idbRun("readonly", st => st.get("content")); return rec && rec.key ? rec.key : null; }
  catch (e) { return null; }
}
function forgetKey() {
  try { indexedDB.deleteDatabase(IDB_NAME); } catch (e) { /* 消せなくても続ける */ }
}

/* 鍵（生バイトまたは CryptoKey）で中身を開く */
async function openContent(k) {
  if (started) return true;
  subkeys = ArrayBuffer.isView(k) ? await GC.deriveSubkeys(k) : { kEnc: k, kId: null };   // 生バイトなら副鍵を作る。CryptoKey ならそのまま
  const res = await fetch(`enc/m.bin?h=${(keys && keys.manifest && keys.manifest.h) || ""}`, { cache: "force-cache" });
  if (!res.ok) throw new Error("本体を取得できません");
  const plain = await GC.open(subkeys.kEnc, new Uint8Array(await res.arrayBuffer()), "manifest");
  manifest = JSON.parse(new TextDecoder().decode(plain));
  installImageResolver();
  start(manifest);
  return true;
}

/* 解錠後の初期化。テストもここを通す（本番と同じ入口） */
function start(payload, opts) {
  DATA = payload.data;
  COPY = payload.copy || {};
  manifest = manifest || payload;
  if (opts && opts.imageSrc) { imageSrc = opts.imageSrc; requestImage = (p, el) => { if (el) el.src = opts.imageSrc(p); }; }
  TABS = (COPY.tabs || []).slice();
  PRICE_BANDS = (COPY.bands || []).map(b => Object.assign({}, b, { test: BAND_TEST[b.key] || (() => false) }));
  SORTS = (COPY.sorts || []).slice();
  TRYON_VARIANTS = (COPY.variants || []).slice();
  ITEMS = DATA.items;
  BY_ID = Object.fromEntries(ITEMS.map(it => [it.id, it]));
  TRYON_MAP = payload.tryon || {};
  PRICE = Object.fromEntries(ITEMS.map(it => [it.id, parsePrice(it.price)]));
  started = true;
  applyHeroCopy();
  if (!TRYON_VARIANTS.some(v => v.key === ui.tryon)) ui.tryon = (TRYON_VARIANTS[0] || { key: "red" }).key;
  if (location.hash) routeFromHash(); else renderAll();
  if (!document.querySelector("#cards .card, #guide-shortlist .mini")) renderAll();
  refreshStatus();
}
function applyHeroCopy() {
  const h = COPY.hero || {};
  const set = (sel, html) => { const el = $(sel); if (el && html) el.innerHTML = html; };
  set("#hero-kicker", esc(h.kicker));
  set("#hero-title", `${esc(h.title || "")}<span>${esc(h.titleAccent || "")}</span>`);
  set("#hero-lead", isOwner() ? (h.lead || "") : (h.leadGuest || h.lead || ""));
  document.body.classList.toggle("read-only", !isOwner());
  const forget = $("#forget-device");
  if (forget) forget.hidden = isOwner() || !started;
}

/* 合言葉で開く */
let passBusy = false;
async function unlockWithPass(pass, remember) {
  if (passBusy || !keys) return;
  passBusy = true;
  setStatus("鍵を作っています…", "");
  try {
    const k = await GC.unwrapK(keys, pass);
    if (!k) { setStatus("合言葉が違います", "error"); return; }
    if (remember) { const ok = await rememberKey(k); if (!ok) setStatus("この端末では記憶できませんでした", ""); }
    await openContent(k);
  } catch (e) {
    setStatus("開けませんでした。通信状態を確認して、もう一度お試しください。", "error");
  } finally { passBusy = false; }
}

/* 2人の扉：Firebase から鍵を受け取る。合わないときは理由が分かるように出す（合言葉の扉は残す） */
function onContentKey(value) {
  if (started) return;
  const raw = value && typeof value === "object" ? value.k : value;
  const text = typeof raw === "string" ? raw.trim().replace(/^["']|["']$/g, "") : "";
  const hint = t => `${t.slice(0, 4)}…${t.slice(-4)}`;
  if (!text) { setStatus("鍵が未登録です。合言葉で開いてください", "error"); return; }
  let bytes = null;
  try { bytes = GC.b64uDec(text); } catch (e) { /* 下で知らせる */ }
  if (!bytes || bytes.length !== 32) {
    setStatus(`登録された鍵の形が違います（${text.length}文字 ${hint(text)}）。合言葉で開いてください`, "error");
    return;
  }
  openContent(bytes).catch(() => setStatus(`登録された鍵では開けません（${hint(text)}）。Console の key/k を確認してください。合言葉では開けます`, "error"));
}

/* ---------- 起動 ---------- */
window.Catalog = { onAuth, onContentKey, setStatus, clearCache, parsePrice, beginNote, endNote, start,
  unlockWithPass, forgetKey, isOwner, signInRequest, state: () => ({ ui, shared, myUid, syncState, unlocked, started }) };
bind();
refreshStatus();
window.dispatchEvent(new Event("catalog-ready"));

async function boot() {
  if (typeof fetch !== "function" || typeof GC === "undefined") return;   // テスト環境では start() を直接呼ぶ
  try {
    const res = await fetch("enc/keys.json", { cache: "no-cache" });
    keys = await res.json();
  } catch (e) { setStatus("接続できませんでした。通信状態を確認して再読み込みしてください。", "error"); return; }
  // 1) 端末に覚えた鍵
  const remembered = await rememberedKey();
  if (remembered) { try { await openContent(remembered); return; } catch (e) { forgetKey(); } }
  // 2) ログイン済みの2人は Firebase から鍵を受け取る（auth.js が onAuth を呼ぶ）
  if (localStorage.getItem(OWNER_FLAG)) loadAuth();
  // 3) それ以外は入口を出す
  gateReady = true;
  document.body.classList.remove("auth-pending");
  refreshStatus();
  if (PREVIEW) previewUnlock();
}
/* 手元確認用：公開サイトには置かれないファイルから鍵を読む */
async function previewUnlock() {
  try {
    const res = await fetch("secrets/content-key.local.json", { cache: "no-cache" });
    if (!res.ok) return;
    await openContent(GC.b64uDec((await res.json()).k));
  } catch (e) { /* 公開サイトではここに来ない */ }
}
let authLoading = null;
function loadAuth() {
  if (!authLoading) authLoading = import("./auth.js?v=" + (window.GC_V || "")).catch(() => { setStatus("ログインの準備に失敗しました", "error"); authLoading = null; });
  return authLoading;
}
/* ログインボタン：押されて初めて Firebase を読み込む（閲覧専用の人は一切読み込まない） */
function signInRequest() {
  setStatus("ログインの準備をしています…", "");
  loadAuth().then(m => { if (m && m.signIn) m.signIn(); });
}
if (typeof document !== "undefined" && document.getElementById("gate")) boot();
