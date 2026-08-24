/* ══════════════════════════════════════════════
   出題ロジック

   条文（または判例法理）を受け取り、どこを空欄にするかを決めて
   問題を組み立てる。採点の一致率もここ。
   通信もしないし、画面にも触らない ── 入力と出力だけの世界。
   ══════════════════════════════════════════════ */
import { fullText } from "./sources.js?v=20260824q";   // ?v= は ui.js の VERSION と揃える

/* ══════════════════════════════════════════════
   条文の切り分けと、空欄にしてよい部分の判定
   ══════════════════════════════════════════════ */
const OPEN  = new Set(["（","(","「","『","【","〔"]);
const CLOSE = new Set(["）",")","」","』","】","〕"]);

/** 括弧の外にある読点・句点で分割する（区切り記号は保持） */
function splitSegments(text) {
  const segs = []; let cur = "", depth = 0;
  for (const ch of text) {
    if (OPEN.has(ch))  { depth++; cur += ch; continue; }
    if (CLOSE.has(ch)) { if (depth > 0) depth--; cur += ch; continue; }
    if ((ch === "、" || ch === "。") && depth === 0) { segs.push({body:cur, d:ch}); cur = ""; }
    else cur += ch;
  }
  if (cur) segs.push({body:cur, d:""});
  return segs;
}
const joinSegments = segs => segs.map(s => s.body + s.d).join("");

/** 各ブロックが、その文の末尾から何番目か */
function endOffsets(segs) {
  const out = new Array(segs.length).fill(0);
  let start = 0;
  segs.forEach((s, i) => {
    if (s.d === "。" || i === segs.length - 1) {
      for (let j = start; j <= i; j++) out[j] = i - j;
      start = i + 1;
    }
  });
  return out;
}
/** 各ブロックが、その文の先頭かどうか */
function sentenceHeads(segs) {
  const out = []; let head = true;
  segs.forEach(s => { out.push(head); head = (s.d === "。"); });
  return out;
}

const hasBracket = s => [...s].some(c => OPEN.has(c) || CLOSE.has(c));
const strippedLength = t => {
  let n = 0, d = 0;
  for (const ch of t) {
    if (OPEN.has(ch)) { d++; continue; }
    if (CLOSE.has(ch)) { if (d>0) d--; continue; }
    if (d === 0) n++;
  }
  return n;
};

/** 「第十五条第一項」のような他条文への絶対参照を含むか */
function hasArticleRef(s) {
  const kan = "一二三四五六七八九十百千", unit = "条項号";
  const c = [...s];
  for (let i = 0; i < c.length; i++) {
    if (c[i] !== "第") continue;
    let j = i + 1;
    while (j < c.length && kan.includes(c[j])) j++;
    if (j > i + 1 && j < c.length && unit.includes(c[j])) return true;
  }
  return false;
}

/* 単独では問題にならない語 */
const CONNECTIVES = new Set(["ただし","また","かつ","及び","並びに","若しくは","又は",
  "この場合において","前項の場合において","この場合","前項の場合",
  "次項において同じ","以下同じ","この限りでない"]);

/* 含んでいたら除外する導入句 */
const BOILERPLATE = ["次に掲げる","次の各号","次のとおり","次に定める",
  "前項の規定","前二項の規定","前三項の規定","前各項の規定",
  "前条の規定","前二条の規定","前三条の規定","前四条の規定","前五条の規定",
  "前各条の規定","次条の規定","前節の規定","前款の規定","前章の規定",
  "この節の規定","この款の規定",
  "この場合において","以下この条において","以下この款において",
  "以下この節において","以下この章において","次項において",
  "この法律において","この項において"];

/* これで始まるブロックは他条項を指しているだけ */
const REL_PREFIX = ["前項","前二項","前三項","前各項","次項",
  "前条","前二条","前三条","前各条","次条",
  "前号","前二号","前三号","前各号","次号",
  "前節","前款","前章","前編","同項","同条","同号",
  "この項","この条","この節","この款"];

/* 条文の節や句はひらがなで終わる。漢字止まりは列挙項目とみなす */
const endsWithNoun = b => {
  if (!b) return true;
  const code = b.charCodeAt(b.length - 1);
  return !(code >= 0x3041 && code <= 0x3096);
};

/* 文頭の短い主語（「家庭裁判所は」「行政庁は」） */
const COND_END = ["ときは","ときには","場合は","場合には","場合において","ときにおいて","限りは"];
function isBareSubject(b, isHead) {
  if (!isHead || b.length > 8) return false;
  if (COND_END.some(e => b.endsWith(e))) return false;
  return b.endsWith("は") || b.endsWith("が");
}

function isBlankCandidate(b, isHead = false) {
  if (isBareSubject(b, isHead)) return false;
  if (b.length < 5 || b.length > 60) return false;
  if (hasBracket(b)) return false;
  if (CONNECTIVES.has(b)) return false;
  if (BOILERPLATE.some(p => b.includes(p))) return false;
  if (hasArticleRef(b)) return false;
  if (REL_PREFIX.some(p => b.startsWith(p))) return false;
  if (endsWithNoun(b)) return false;
  return true;
}

/* 効果を示す言い回し */
const EFFECT = ["ことができる","なければならない","ものとする","することを要しない",
  "責任を負う","義務を負う","を負う","を有する",
  "効力を生じない","無効とする","妨げない","対抗することができない",
  "取得する","消滅する","推定する","みなす","適用しない","準用する",
  "目的とする","趣旨とする","図るものとする"];

/* その条文でしか出てこない、あるいは繰り返し問われる文言 */
const KEYPHRASE = ["事理を弁識する能力","常況","一時回復","医師二人以上","立会い",
  "同一の錯誤","重大な過失","善意でかつ過失がない","善意の第三者",
  "知り、又は知ることができた","過失がないとき","悪意",
  "信義に従い誠実","権利の濫用","公共の福祉","公の秩序又は善良の風俗",
  "社会通念に照らして","責めに帰することができない事由",
  "所有の意思をもって","平穏に","公然と","完成猶予","更新",
  "通常生ずべき損害","特別の事情によって生じた損害","予見すべきであった",
  "現に利益を受けている限度",
  "遅滞なく","直ちに","速やかに","あらかじめ","相当の期間を定めて",
  "正当な理由","やむを得ない事由","不法な原因のために","法律上の原因なく",
  "簡易迅速かつ公正な手続","公正の確保と透明性の向上","権利利益の救済",
  "適正な運営","違法又は不当","重大な損害","償うことのできない損害",
  "緊急の必要","法律上の利益を有する者","公共の福祉に重大な影響"];

function positionWeight(offset, body) {
  let w = offset === 0 ? 8 : offset === 1 ? 4 : offset === 2 ? 2 : 1;
  if (EFFECT.some(m => body.includes(m))) w *= 2;
  if (KEYPHRASE.some(k => body.includes(k))) w *= 10;
  return w;
}

export function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/* ══════════════════════════════════════════════
   採点：最長共通部分列にもとづく一致率
   ══════════════════════════════════════════════ */
const DROP = new Set(["、","。","　"," ","\n","（","）","(",")"]);
const normalize = s => [...s].filter(c => !DROP.has(c)).join("");

export function similarity(a, b) {
  const x = [...normalize(a)], y = [...normalize(b)];
  if (!x.length || !y.length) return 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i-1] === y[j-1] ? prev[j-1] + 1 : Math.max(prev[j], cur[j-1]);
    }
    prev = cur;
  }
  return prev[y.length] * 2 / (x.length + y.length);
}

/* ══════════════════════════════════════════════
   出題の組み立て
   ══════════════════════════════════════════════ */
const mark = (answer, showHint) =>
  `<span class="blank">＿＿＿＿＿${showHint ? `（${answer.length}字）` : ""}</span>`;

/** 参照だけの項（準用規定など）は使わない */
function isReferenceOnlyParagraph(t) {
  if (!(hasArticleRef(t) || REL_PREFIX.some(p => t.startsWith(p)))) return false;
  return ["準用する","読み替える","適用する","適用しない","例による"]
    .some(m => t.includes(m)) && strippedLength(t) < 120;
}

export function isPoorQuestion(article, mode) {
  const text = fullText(article);
  if (text.length < 25) return true;
  if (/準用する|読み替える/.test(text) && strippedLength(text) < 80) return true;
  if (mode === "descriptive") return !hasDescriptive(article);
  if (mode === "blank") {
    return !article.paragraphs.some(p => {
      if (isReferenceOnlyParagraph(p.text)) return false;
      const segs = splitSegments(p.text), heads = sentenceHeads(segs);
      return segs.some((s, i) => isBlankCandidate(s.body, heads[i]));
    });
  }
  return false;
}

/* 条文ごとに前回どこを空欄にしたか。同じ場所が続かないようにするためだけの記録で、
   画面側からは触らないのでこのモジュールに閉じておく。 */
const lastBlank = new Map();

/** 前回この条文で空欄にした答えを除いた候補を返す（全部消える場合はそのまま） */
function avoidRepeat(cand, segs, key) {
  const prev = lastBlank.get(key);
  if (!prev) return cand;
  const filtered = cand.filter(i => segs[i].body !== prev);
  return filtered.length ? filtered : cand;
}

export function makeBlank(article, showHint, emphasizeEnding, key) {
  const order = article.paragraphs.map((_, i) => i).sort(() => Math.random() - .5);
  for (const pi of order) {
    const text = article.paragraphs[pi].text;
    if (!text || isReferenceOnlyParagraph(text)) continue;
    const segs = splitSegments(text);
    if (segs.length < 2) continue;
    const heads = sentenceHeads(segs), offs = endOffsets(segs);
    let cand = segs.map((s, i) => i).filter(i => isBlankCandidate(segs[i].body, heads[i]));
    if (!cand.length) continue;
    cand = avoidRepeat(cand, segs, key);

    const idx = emphasizeEnding
      ? weightedPick(cand, cand.map(i => positionWeight(offs[i], segs[i].body)))
      : pick(cand);

    const answer = segs[idx].body;
    if (key) lastBlank.set(key, answer);
    const shown = segs.map((s, i) => i === idx ? {body:mark(answer, showHint), d:s.d} : s);
    return {mode:"blank", answer, question:joinSegments(shown), paragraphIndex:pi};
  }
  return null;
}

/* ── 記述式（条文の効果部分を問う） ──────────

   本試験の記述式は「〜の場合、Xはどうなるか」を40字程度で書かせる。
   条文をそのまま長く空欄にすると、条件節ごと消えて手がかりが無くなり、
   実質「全文再現」になってしまう。そこで次を満たす範囲だけを空欄にする。

   ・文末で終わること（効果部分を答えさせる）
   ・文の先頭からは始めないこと（条件節と主語を手がかりとして必ず残す）
   ・残る手がかりが十分な長さであること
   ・答えが40字程度に収まること
   ────────────────────────────── */
const DESC_TARGET = 40;   // 本試験の字数
const DESC_MIN = 28, DESC_MAX = 50;
const DESC_NEAR = 6;      // 40字±6 を優先して選ぶ
const PREFIX_MIN = 12;    // 空欄の前に残す手がかりの最小字数

/** その文のうち、空欄の前に残る文字数 */
function prefixLength(segs, start) {
  let n = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (segs[i].d === "。") break;   // 前の文まで遡らない
    n += segs[i].body.length;
  }
  return n;
}

/** 記述式に使える範囲を [開始, 終了, 字数] で返す */
function descriptiveSpans(segs, heads, offs) {
  const spans = [];
  for (let end = 0; end < segs.length; end++) {
    if (offs[end] !== 0) continue;              // 文末で終わる範囲だけ
    for (let start = end; start >= 0; start--) {
      const bodies = segs.slice(start, end + 1).map(s => s.body);
      const joined = bodies.join("、");
      if (joined.length > DESC_MAX) break;
      const ok = bodies.every(b => b && !hasBracket(b) && !hasArticleRef(b) && !CONNECTIVES.has(b)
                 && !BOILERPLATE.some(p => b.includes(p)))
                 && !REL_PREFIX.some(p => bodies[0].startsWith(p))
                 && !isBareSubject(bodies[0], heads[start]);   // 主語だけを問わない
      if (ok && joined.length >= DESC_MIN
          && !heads[start]                                     // 文頭からは空欄にしない
          && prefixLength(segs, start) >= PREFIX_MIN) {
        spans.push([start, end, joined.length]);
      }
      if (start > 0 && segs[start - 1].d === "。") break;
    }
  }
  return spans;
}

/** その条文から40字程度の記述式が作れるか */
export function hasDescriptive(article) {
  return article.paragraphs.some(p => {
    if (!p.text || isReferenceOnlyParagraph(p.text)) return false;
    const segs = splitSegments(p.text);
    return descriptiveSpans(segs, sentenceHeads(segs), endOffsets(segs)).length > 0;
  });
}

export function makeDescriptive(article, showHint, key) {
  for (const pi of article.paragraphs.map((_, i) => i).sort(() => Math.random() - .5)) {
    const text = article.paragraphs[pi].text;
    if (!text || isReferenceOnlyParagraph(text)) continue;
    const segs = splitSegments(text), offs = endOffsets(segs), heads = sentenceHeads(segs);
    const spans = descriptiveSpans(segs, heads, offs);
    if (!spans.length) continue;

    // 40字に近いものを優先し、無ければ全候補から選ぶ
    const near = spans.filter(s => Math.abs(s[2] - DESC_TARGET) <= DESC_NEAR);
    let pool = near.length ? near : spans;
    const prev = key ? lastBlank.get(key) : null;
    const fresh = pool.filter(([a, b]) => segs.slice(a, b + 1).map(s => s.body).join("、") !== prev);
    if (fresh.length) pool = fresh;

    const [s0, s1] = pick(pool);
    const answer = segs.slice(s0, s1 + 1).map(s => s.body).join("、");
    if (key) lastBlank.set(key, answer);
    const shown = [...segs.slice(0, s0), {body:mark(answer, showHint), d:segs[s1].d}, ...segs.slice(s1 + 1)];
    return {mode:"descriptive", answer, question:joinSegments(shown), paragraphIndex:pi};
  }
  // 40字の問題が作れない条文は、呼び出し側で引き直してもらう
  return null;
}

/* ══════════════════════════════════════════════
   事例記述の採点

   採点キーワードは正規表現として扱う。「訴えを提起」と「訴訟を提起」のような
   表記のゆれを列挙で潰すのは無理があるので、1つの式で吸収する。
   正規表現として壊れている場合は、そのまま文字列として照合する。

   もっとも、式をどれだけ丁寧に書いても、同じ中身を別の言い回しで書いた解答は
   取りこぼす。実際に落ちたのは、次の4つの型だった。

     送り仮名と助詞  「償うことのできない」と「償うことができない」
     語の割り込み    「他に適当な方法」と「他に適当な救済方法」
     並立の語順      「利益の内容及び性質」と「利益の性質及び内容」
     可能動詞の否定  「拒むことができない」と「拒めず」

   どれも条文の言い回しを少し崩しただけで、書いてあることは変わらない。
   そこで、解答とキーワードの双方に同じ言い換えをかけたものでも照合する。
   言い換えた形は「追加で試す」だけで、元のままの照合も必ず行うから、
   拾えるものが増えることはあっても、減ることはない。

   否定を崩す言い換えだけは入れない。「拒める」と「拒めない」を取り違えると
   誤答に点を与えてしまう。
   ══════════════════════════════════════════════ */

/* 送り仮名のゆれ。送らない形に寄せる（左から順に適用する） */
const OKURIGANA = [
  ["取り消","取消"], ["取消し","取消"], ["明け渡","明渡"], ["明渡し","明渡"],
  ["差し引","差引"], ["差引き","差引"], ["申し立て","申立"], ["申立て","申立"],
  ["申し出","申出"], ["引き渡","引渡"], ["引渡し","引渡"], ["支払い","支払"],
  ["立ち入","立入"], ["立入り","立入"], ["取り扱","取扱"], ["取扱い","取扱"],
  ["差し押さえ","差押"], ["差押え","差押"], ["打ち消","打消"], ["打消し","打消"],
  ["譲り渡","譲渡"], ["買い受け","買受"], ["貸し付け","貸付"],
  ["申し込","申込"], ["申込み","申込"], ["受け取","受取"], ["立ち退","立退"],
  ["割り当て","割当"], ["見做","みな"], ["看做","みな"],
];

/* 「ことができる」「ことのできる」「事が出来る」を「できる」に揃える */
const KOTO_DEKIRU = /(こと|事)(が|の|は|も)?(でき|出来)/g;

/* 「対抗し得ない」を「対抗できない」に揃える */
const SHIURU = /(?:為し得|なし得|し得|しえ)/g;

/* 「六箇月」「6ヶ月」を「6月」に揃える。助数詞のかなを落としてから数字に直す。
   先読みを付けているのは、「一定」「一部」まで数字にしてしまわないため。 */
const COUNTER_KANA = /(?:箇|ヶ|ケ|か|カ|个)(?=[月年日])/g;
const KANSUJI = {"二十":"20","三十":"30","四十":"40","五十":"50",
  "十":"10","一":"1","二":"2","三":"3","四":"4",
  "五":"5","六":"6","七":"7","八":"8","九":"9"};
const KANSUJI_RE = /(二十|三十|四十|五十|十|[一二三四五六七八九])(?=[月年日])/g;

/* 「1/3」を「3分の1」に揃える。相続分や遺留分は、答案でスラッシュで書かれることがある。
   後ろに数字が続くときは変換しない。normalize が括弧を落とすため「1/6(100万円)」は
   「1/6100万円」になっており、これを分数として読むと 6100分の1 になってしまう。
   拾えないのは構わないが、取り違えるのは避ける。 */
const FRACTION = /(\d{1,3})\/(\d{1,3})(?!\d)/g;

function loosen(s) {
  let t = s;
  for (const [from, to] of OKURIGANA) t = t.split(from).join(to);
  t = t.replace(SHIURU, "でき");
  t = t.replace(KOTO_DEKIRU, "でき");
  t = t.replace(COUNTER_KANA, "");
  t = t.replace(FRACTION, (_, a, b) => `${b}分の${a}`);
  return t.replace(KANSUJI_RE, m => KANSUJI[m]);
}

/* 「拒めず」のような可能動詞の否定を「拒むことができない」に開く。
   え段を う段に戻して「ことができない」を足すだけで、否定はそのまま残す。

   「れ」と「ね」は扱わない。「免れない」「兼ねない」は形のうえでは同じ並びなのに
   意味は逆（免れられない＝負う）で、開いてしまうと「できない」を書いていない解答に
   否定の要素を与えてしまう。「認められない」のように拾いたいものは、
   各問題のキーワードにそのまま並べてある。 */
const E_TO_U = {え:"う",け:"く",げ:"ぐ",せ:"す",て:"つ",へ:"ふ",べ:"ぶ",め:"む"};
const POTENTIAL_NEG = /([ぁ-んァ-ヴ一-龥])([えけげせてへべめ])(?:ない|ず|ぬ|ません|なかった)/g;
const expandNegation = s =>
  s.replace(POTENTIAL_NEG, (_, stem, e) => stem + E_TO_U[e] + "ことができない");

/* 正規表現の記号。ここに当たらない文字の連なりだけを言い換えの対象にする */
const RE_META = /[\\^$.|?*+()[\]{}]/;
const NOT_META = "[^\\\\^$.|?*+()[\\]{}]";

/** 正規表現のうち、記号ではない部分にだけ言い換えをかける */
function loosenPattern(p) {
  let out = "", run = "";
  for (const ch of p) {
    if (RE_META.test(ch)) { out += loosen(run) + ch; run = ""; }
    else run += ch;
  }
  return out + loosen(run);
}

/** 「A.{0,n}B」を「B.{0,n}A」にする。並立の語順が入れ替わった解答を拾う */
const TWO_TERMS = new RegExp(`^(${NOT_META}+)\\.\\{0,(\\d+)\\}(${NOT_META}+)$`);
function flipTerms(p) {
  const m = TWO_TERMS.exec(p);
  return m ? `${m[3]}.{0,${m[2]}}${m[1]}` : null;
}

/** 記号を含まない4字以上のキーワードに、1箇所だけ4字までの割り込みを許す。
    「適当な方法」で「適当な救済方法」を拾うための、最後の手段。 */
function allowInsertion(p) {
  const c = [...p];
  if (RE_META.test(p) || c.length < 4) return null;
  const alts = [];
  for (let i = 1; i < c.length; i++)
    alts.push(c.slice(0, i).join("") + ".{0,4}" + c.slice(i).join(""));
  return alts.join("|");
}

function toRegExp(w) {
  try { return new RegExp(w); }
  catch (e) { return new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
}

/* キーワード1つにつき、照合に使う式は数本になる。作り直さないよう覚えておく */
const formsCache = new Map();
function forms(w) {
  let f = formsCache.get(w);
  if (f) return f;
  const strict = [w];
  const l = loosenPattern(w);
  if (l !== w) strict.push(l);
  for (const p of strict.slice()) { const t = flipTerms(p); if (t) strict.push(t); }
  const loose = [];
  for (const p of strict) { const ins = allowInsertion(p); if (ins) loose.push(ins); }
  f = {
    strict: [...new Set(strict)].map(toRegExp),
    loose:  [...new Set(loose)].map(toRegExp),
  };
  formsCache.set(w, f);
  return f;
}

/** 解答を、照合に使う何通りかの書き方に開く。どう開いたものかも添える。
    どの書き方で当たったのかが分かると、採点の理由を学習者に示せる */
function readings(input) {
  const base = normalize(input);
  const neg  = expandNegation(base);
  const list = [
    {text: base,         how: ""},
    {text: loosen(base), how: "表記のゆれを吸収して"},
    {text: neg,          how: "打ち消しの言い換えを開いて"},
    {text: loosen(neg),  how: "表記のゆれと打ち消しを開いて"},
  ];
  const seen = new Set();
  return list.filter(r => { if (seen.has(r.text)) return false; seen.add(r.text); return true; });
}

/** キーワード w が、解答のいずれかの書き方のどこに現れるか。現れなければ null。
    元のままの照合を先に試すので、素直に当たったものは素直な形で返る */
function findMatch(w, reads) {
  const f = forms(w);
  for (const [group, spread] of [[f.strict, false], [f.loose, true]]) {
    for (const re of group) {
      for (const r of reads) {
        const m = re.exec(r.text);
        if (m) return {text: m[0], how: r.how, spread};
      }
    }
  }
  return null;
}

/** キーワード w が、解答のいずれかの書き方に現れるか */
function appears(w, texts) {
  const f = forms(w);
  return f.strict.some(re => texts.some(t => re.test(t)))
      || f.loose.some(re => texts.some(t => re.test(t)));
}

/** 事例記述の要素採点。本試験と同じく要素ごとの部分点で採る。
    各要素には、なぜそう採ったのかを match / impliedFrom に残す */
export function scoreCase(input, points) {
  const reads = readings(input);
  const detail = points.map(p => {
    let match = null;
    for (const w of p.words) { match = findMatch(w, reads); if (match) break; }
    return {
      label: p.label,
      example: p.example || "",
      point: p.point,
      hit: !!match,
      match,              // {text, how, spread} ── 解答のどこが当たったか
      implied: false,
      impliedFrom: "",    // 含意で採った場合、その元になった要素
    };
  });

  /* 他の要素を書いた時点で当然そこに含まれている、という要素を拾う。
     「直接自己への明渡しを請求できる」と書いてあれば占有の排除も求めている。
     含意が連鎖することがあるので、増えなくなるまで回す。 */
  const found = new Map(detail.map(d => [d.label, d]));
  for (let again = true; again; ) {
    again = false;
    points.forEach((p, i) => {
      if (detail[i].hit || !p.impliedBy) return;
      const src = p.impliedBy.find(l => found.get(l) && found.get(l).hit);
      if (!src) return;
      detail[i].hit = true; detail[i].implied = true; detail[i].impliedFrom = src; again = true;
    });
  }

  const full = points.reduce((a, p) => a + p.point, 0);
  const earned = detail.reduce((a, d) => a + (d.hit ? d.point : 0), 0);
  return {detail, earned, full, pct: full ? Math.round(earned / full * 100) : 0};
}

export function makeDoctrine(d, showHint, key) {
  const segs = splitSegments(d.statement);
  const heads = sentenceHeads(segs), offs = endOffsets(segs);
  let cand = segs.map((s, i) => i).filter(i => isBlankCandidate(segs[i].body, heads[i]));
  if (!cand.length) return null;
  cand = avoidRepeat(cand, segs, key);
  const idx = weightedPick(cand, cand.map(i => positionWeight(offs[i], segs[i].body)));
  const answer = segs[idx].body;
  if (key) lastBlank.set(key, answer);
  const shown = segs.map((s, i) => i === idx ? {body:mark(answer, showHint), d:s.d} : s);
  const topic = [d.heading, d.term].filter(Boolean).join("／");
  return {mode:"doctrine", answer, topic, question:joinSegments(shown), paragraphIndex:-1};
}
