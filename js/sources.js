/* ══════════════════════════════════════════════
   条文・判例の取得

   外部の二つの出典から取ってきて、アプリ内の形に変換するところまで。
   ・e-Gov 法令API   … 条文そのもの（XML）
   ・Wikibooks       … 判例と解説（wikitext）

   出題の判断も画面の描画もここではしない。DOM は XML の解析にしか触らない。
   ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   条文の取得（e-Gov 法令API）
   ══════════════════════════════════════════════ */
const artForms = n => {
  const t = String(n).trim();
  const out = [t];
  if (t.includes("_")) out.push(t.replace(/_/g, "の"));
  if (t.includes("の")) out.push(t.replace(/の/g, "_"));
  return [...new Set(out)];
};

const txt = el => (el ? el.textContent.trim() : "");
const kids = (el, tag) => el ? [...el.children].filter(c => c.tagName === tag) : [];
const kid  = (el, tag) => kids(el, tag)[0] || null;
const deep = (el, tag) => el ? [...el.getElementsByTagName(tag)] : [];

/** 号の本文などで欄が複数あれば区切りを保つ（「〜のとき」／「聴聞」） */
function sentenceText(el) {
  if (!el) return "";
  const cols = kids(el, "Column");
  if (cols.length >= 2) {
    return cols.map(c => deep(c, "Sentence").map(txt).join(""))
               .filter(Boolean).join("　→　");
  }
  return deep(el, "Sentence").map(txt).join("");
}

function parseParagraph(p) {
  const num = txt(kid(p, "ParagraphNum"));
  const text = sentenceText(kid(p, "ParagraphSentence"));
  const items = [];
  for (const it of kids(p, "Item")) {
    const t = txt(kid(it, "ItemTitle"));
    const body = sentenceText(kid(it, "ItemSentence"));
    if (body) items.push(t ? `${t}　${body}` : body);
    for (const s1 of kids(it, "Subitem1")) {
      const t1 = txt(kid(s1, "Subitem1Title"));
      const b1 = sentenceText(kid(s1, "Subitem1Sentence"));
      if (b1) items.push("　" + (t1 ? `${t1}　${b1}` : b1));
      for (const s2 of kids(s1, "Subitem2")) {
        const t2 = txt(kid(s2, "Subitem2Title"));
        const b2 = sentenceText(kid(s2, "Subitem2Sentence"));
        if (b2) items.push("　　" + (t2 ? `${t2}　${b2}` : b2));
      }
    }
  }
  return (text || items.length) ? {num, text, items} : null;
}

/** 条文を平文に組む。replaceIndex の項だけ replacement に差し替える */
export function renderArticle(article, replaceIndex, replacement) {
  const lines = [];
  article.paragraphs.forEach((p, i) => {
    const body = (i === replaceIndex && replacement != null) ? replacement : p.text;
    if (body) lines.push((p.num ? p.num + "　" : "") + body);
    p.items.forEach(x => lines.push("　" + x));
  });
  return lines.join("\n");
}
export const fullText = a => renderArticle(a, -1, null);

export async function fetchArticle(law, num) {
  let last = null;
  for (const form of artForms(num)) {
    const url = `https://laws.e-gov.go.jp/api/1/articles;lawId=${law.id};article=${encodeURIComponent(form)};`;
    let raw;
    try {
      const res = await fetch(url);
      if (!res.ok) { last = new Error(`e-Gov が HTTP ${res.status} を返しました`); continue; }
      raw = await res.text();
    } catch (e) {
      // ここに来るのは通信そのものが遮られた場合（file:// で開いた／回線断／CORS）
      throw new Error("e-Gov に接続できませんでした（" + e.message + "）");
    }
    try {
      const doc = new DOMParser().parseFromString(raw, "application/xml");
      if (doc.querySelector("parsererror")) { last = new Error("XML を解釈できませんでした"); continue; }
      const code = txt(doc.querySelector("Code"));
      if (code !== "0") { last = new Error(`e-Gov に第${form}条が見つかりません`); continue; }

      // 応答の ApplData には <Article>177</Article> のように
      // 要求内容を反射した同名の要素が入る。本文は LawContents の中だけを見る。
      const contents = doc.querySelector("LawContents");
      if (!contents) { last = new Error("本文の位置を特定できませんでした"); continue; }

      const art = kid(contents, "Article");
      const scope = art || contents;

      let paragraphs = kids(scope, "Paragraph").map(parseParagraph).filter(Boolean);
      if (!paragraphs.length) {
        paragraphs = deep(scope, "Paragraph").map(parseParagraph).filter(Boolean);
      }
      if (!paragraphs.length) { last = new Error("条文の本文が空でした"); continue; }

      return {
        lawName: law.name,
        caption: txt(kid(art, "ArticleCaption")),
        title:   txt(kid(art, "ArticleTitle")) || `第${form}条`,
        paragraphs,
      };
    } catch (e) { last = new Error("解析に失敗しました（" + e.message + "）"); }
  }
  throw last || new Error("取得できませんでした");
}

/** 編・章・節ごとの条文一覧（本則のみ） */
export async function fetchIndex(law) {
  const res = await fetch(`https://laws.e-gov.go.jp/api/1/lawdata/${law.id}`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  const main = doc.querySelector("MainProvision");
  if (!main) throw new Error("本則が見つかりません");

  const groups = new Map();
  const seen = new Set();
  const titleOf = (el, tag) => txt(kid(el, tag)).replace(/\u3000/g, " ");

  for (const a of main.querySelectorAll("Article")) {
    if (a.getAttribute("Delete") === "true") continue;
    const num = a.getAttribute("Num");
    if (!num || seen.has(num)) continue;
    seen.add(num);

    const parts = [];
    let node = a.parentElement;
    while (node && node !== main) {
      if (node.tagName === "Part")    parts.unshift(titleOf(node, "PartTitle"));
      if (node.tagName === "Chapter") parts.unshift(titleOf(node, "ChapterTitle"));
      if (node.tagName === "Section") parts.unshift(titleOf(node, "SectionTitle"));
      node = node.parentElement;
    }
    const path = parts.filter(Boolean).join(" ＞ ") || "全体";
    const key = law.id + "|" + path;
    if (!groups.has(key)) groups.set(key, {lawId:law.id, lawName:law.name, law, path, articles:[]});
    groups.get(key).articles.push(num);
  }
  return [...groups.values()].filter(g => g.articles.length);
}

/* ══════════════════════════════════════════════
   Wikibooks コンメンタール（判例・解説）
   ══════════════════════════════════════════════ */
const wikiPage = (law, num) =>
  law.wiki ? `${law.wiki}第${String(num).replace(/_/g, "の")}条` : null;
export const wikiURL = (law, num) => {
  const p = wikiPage(law, num);
  return p ? "https://ja.wikibooks.org/wiki/" + encodeURIComponent(p) : null;
};

export async function fetchWikitext(law, num) {
  const page = wikiPage(law, num);
  if (!page) return null;
  const url = "https://ja.wikibooks.org/w/api.php?action=parse&page="
    + encodeURIComponent(page)
    + "&prop=wikitext&format=json&formatversion=2&redirects=1&origin=*";
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.error || !json.parse) return null;
  return json.parse.wikitext || null;
}

/** wiki記法を落として読める文にする */
function wclean(text) {
  let s = text;
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\]/g, "");
  s = s.replace(/\{\{[^}]*\}\}/g, "");
  s = s.replace(/'{2,}/g, "");
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/ {2,}/g, " ").trim();
  s = s.replace(/^[;:*#\s\u3000]+/, "");
  return s.trim();
}
const firstURL = line => {
  const m = line.match(/https?:\/\/[^\s\]|}]+/);
  return m ? m[0] : null;
};

/** 判例の一覧 */
export function parsePrecedents(wikitext) {
  const out = [];
  let inSec = false, pending = null, pendingLink = null;
  const flush = () => { if (pending) out.push({title:pending, summary:"", link:pendingLink}); pending = null; pendingLink = null; };

  for (const raw of wikitext.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("=")) {
      const h = line.replace(/=/g, "").trim();
      if (h.includes("判例")) inSec = true;
      else if (inSec) { flush(); inSec = false; }
      continue;
    }
    if (!inSec || !line) continue;

    if (/^([#*]:|::)/.test(line)) {
      const body = wclean(line.replace(/^([#*]:|::)/, ""));
      if (!body) continue;
      if (pending) { out.push({title:pending, summary:body, link:pendingLink}); pending = null; pendingLink = null; }
      else if (out.length) {
        const last = out.pop();
        out.push({...last, summary: last.summary ? last.summary + " " + body : body});
      }
      continue;
    }
    if (/^[#*]/.test(line)) {
      flush();
      const rest = line.slice(1);
      const body = wclean(rest);
      if (body) { pending = body; pendingLink = firstURL(rest); }
    }
  }
  flush();
  return out.filter(p => p.title);
}

/** 解説欄から判例法理を取り出す */
const STOP_HEADINGS = ["判例","参照条文","脚注","外部リンク","関連","前条","次条","条文"];
const CONCLUSIONS = ["必要である","必要とされる","必要としない","要しない",
  "対抗できる","対抗できない","対抗することができる","対抗することができない",
  "できる","できない","とされる","とされている",
  "あたる","当たる","あたらない","当たらない",
  "有効","無効","認められる","認められない",
  "成立する","成立しない","消滅する","解される","解されている"];

const isRuleStatement = t =>
  t.length >= 15 && t.length <= 120 &&
  CONCLUSIONS.some(c => t.includes(c)) &&
  !/書きかけ|加筆|編集/.test(t);

/** 行内で用語と説明を分ける「:」（リンクやURLの中では切らない） */
function topLevelColon(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { if (depth > 0) depth--; }
    else if (ch === ":" && depth === 0) {
      if (/https?$/.test(text.slice(0, i))) continue;
      return i;
    }
  }
  return -1;
}

export function parseDoctrines(wikitext) {
  const out = [];
  let inSec = false, heading = "", term = "";

  for (const raw of wikitext.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("=")) {
      const level = (line.match(/^=+/) || [""])[0].length;
      const title = wclean(line.replace(/=/g, "").trim());
      if (title.includes("解説")) { inSec = true; heading = ""; term = ""; continue; }
      if (inSec && level <= 2 && STOP_HEADINGS.some(s => title.includes(s))) { inSec = false; continue; }
      if (inSec) { heading = title; term = ""; }
      continue;
    }
    if (!inSec || !line) continue;

    if (line.startsWith(";")) {
      const rest = line.slice(1);
      const c = topLevelColon(rest);
      if (c >= 0) {
        const t = wclean(rest.slice(0, c)), body = wclean(rest.slice(c + 1));
        if (isRuleStatement(body)) out.push({heading, term:t, statement:body});
        term = "";
      } else term = wclean(rest);
      continue;
    }
    if (line.startsWith(":")) {
      const body = wclean(line.slice(1));
      if (isRuleStatement(body)) out.push({heading, term, statement:body});
      term = "";
      continue;
    }
    if (/^[*#]/.test(line)) {
      const body = wclean(line.slice(1));
      if (isRuleStatement(body)) out.push({heading, term:"", statement:body});
      continue;
    }
    if (/^[{|<]/.test(line)) continue;

    for (const sen of wclean(line).split("。")) {
      const s = sen.trim();
      if (s && isRuleStatement(s + "。")) out.push({heading, term:"", statement:s + "。"});
    }
  }
  return out;
}
