/* 中身の暗号化・復号。ブラウザ（window.GC）と Node（require）の両方から同じコードを使う。
   方式: AES-256-GCM。鍵 K（32バイト）から用途ごとの副鍵を HKDF で作る。
   ・K_enc … 本文と画像の暗号化
   ・K_id  … ファイル名と IV の導出（HMAC-SHA256）
   合言葉の扉は PBKDF2-SHA256 で K を包み直したもの（enc/keys.json）を開く。
   IV は内容から決める（同じ内容なら同じ暗号文になり、再生成しても差分が出ない）。 */
"use strict";
(function (root, factory) {
  const GC = factory(typeof globalThis !== "undefined" ? globalThis : root);
  if (typeof module !== "undefined" && module.exports) module.exports = GC;
  else root.GC = GC;
})(typeof self !== "undefined" ? self : this, function (g) {
  const subtle = g.crypto && g.crypto.subtle;
  const MAGIC = [0x47, 0x43, 0x32, 0x36];   // "GC26"
  const VERSION = 1;
  const HEADER = 20;                        // magic4 + version1 + flags1 + reserved2 + iv12
  const enc = new TextEncoder();

  function bytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function concat(list) {
    const n = list.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(n);
    let i = 0;
    for (const a of list) { out.set(a, i); i += a.length; }
    return out;
  }
  function b64uEnc(buf) {
    const b = bytes(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    const base = typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
    return base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uDec(str) {
    const base = String(str).replace(/-/g, "+").replace(/_/g, "/");
    const pad = base + "=".repeat((4 - (base.length % 4)) % 4);
    if (typeof atob === "function") {
      const s = atob(pad);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(pad, "base64"));
  }
  function hex(buf) { return [...bytes(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }

  /* 合言葉の正規化：IME や自動大文字化で別の鍵にならないように揃える */
  function normalizePass(pass) { return String(pass == null ? "" : pass).normalize("NFKC").trim(); }

  async function deriveKEK(pass, salt, iterations) {
    const base = await subtle.importKey("raw", enc.encode(normalizePass(pass)), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt: bytes(salt), iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /* K から用途別の副鍵を作る（HKDF-SHA256） */
  async function deriveSubkeys(k) {
    const raw = bytes(k);
    if (raw.length !== 32) throw new Error("鍵の長さが違います");
    const base = await subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]);
    const info = s => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(s) });
    const kEnc = await subtle.deriveKey(info("gc26/v1/enc"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const idBits = await subtle.deriveBits(info("gc26/v1/id"), base, 256);
    const kId = await subtle.importKey("raw", idBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return { kEnc, kId };
  }

  async function hmac(kId, parts) { return bytes(await subtle.sign("HMAC", kId, concat(parts.map(p => typeof p === "string" ? enc.encode(p) : bytes(p))))); }
  async function sha256(data) { return bytes(await subtle.digest("SHA-256", bytes(data))); }

  /* 公開する暗号文のファイル名（何の写真か外から分からないように鍵から導く） */
  async function blobName(kId, path) { return hex(await hmac(kId, ["name\0", path])).slice(0, 16); }
  /* IV は内容から決める：同じ内容なら同じ暗号文 → 再生成しても差分ゼロ、閲覧側のキャッシュも効く */
  async function blobIv(kId, path, plain) { return (await hmac(kId, ["iv\0", path, "\0", await sha256(plain)])).slice(0, 12); }
  /* 内容の短い指紋（キャッシュ更新の目印） */
  async function contentTag(kId, path, plain) { return hex(await hmac(kId, ["tag\0", path, "\0", await sha256(plain)])).slice(0, 6); }

  function header(iv) {
    const h = new Uint8Array(HEADER);
    h.set(MAGIC, 0);
    h[4] = VERSION;
    h.set(bytes(iv), 8);
    return h;
  }
  function parseHeader(buf) {
    const b = bytes(buf);
    if (b.length < HEADER + 16) throw new Error("暗号文が短すぎます");
    if (MAGIC.some((m, i) => b[i] !== m)) throw new Error("暗号文の形式が違います");
    if (b[4] !== VERSION) throw new Error("暗号文の版が違います");
    return { iv: b.slice(8, 20), body: b.slice(HEADER) };
  }

  /* path を AAD に混ぜる：別のファイルの暗号文を差し替えても開けない */
  async function seal(kEnc, iv, plain, path) {
    const ct = await subtle.encrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(path) }, kEnc, bytes(plain));
    return concat([header(iv), bytes(ct)]);
  }
  async function open(kEnc, buf, path) {
    const { iv, body } = parseHeader(buf);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(path) }, kEnc, body);
    return new Uint8Array(plain);
  }

  /* 合言葉で K を包む／開く（enc/keys.json の wraps[]） */
  async function wrapKey(k, pass, salt, iterations) {
    const kek = await deriveKEK(pass, salt, iterations);
    const iv = g.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("wrap") }, kek, bytes(k));
    return { iv: b64uEnc(iv), ct: b64uEnc(new Uint8Array(ct)) };
  }
  async function unwrapK(keys, pass) {
    const kek = await deriveKEK(pass, b64uDec(keys.kdf.salt), keys.kdf.iter);
    for (const w of keys.wraps || []) {
      try {
        const raw = await subtle.decrypt({ name: "AES-GCM", iv: b64uDec(w.iv), additionalData: enc.encode("wrap") }, kek, b64uDec(w.ct));
        return new Uint8Array(raw);
      } catch (e) { /* この合言葉ではない。次を試す */ }
    }
    return null;   // 合言葉が違う
  }

  return { MAGIC, VERSION, HEADER, b64uEnc, b64uDec, hex, normalizePass, deriveKEK, deriveSubkeys,
    blobName, blobIv, contentTag, seal, open, parseHeader, wrapKey, unwrapK, sha256 };
});
