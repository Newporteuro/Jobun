/* ══════════════════════════════════════════════
   画面表示

   操作卓の状態を持ち、取得（sources）と出題（drill）を呼び分けて、
   結果を DOM に書く。アプリの入口でもある（末尾で initControls）。
   ══════════════════════════════════════════════ */
/* すべての import に同じ ?v= を付ける。GitHub Pages は max-age=600 を返すため、
   これが無いと index.html だけ新しく、モジュールは古いままという状態が10分間続く。
   ファイルを更新したら VERSION と各 import の ?v= を必ず揃えて上げ直すこと。 */
export const VERSION = "20260824u";

import { LAWS, SCOPES, weightOf } from "./weights.js?v=20260824u";
import {
  fetchArticle, fetchIndex, renderArticle, fullText,
  fetchWikitext, parsePrecedents, parseDoctrines, wikiURL,
} from "./sources.js?v=20260824u";
import {
  makeBlank, makeDescriptive, makeDoctrine,
  isPoorQuestion, similarity, scoreCase, weightedPick, pick,
} from "./drill.js?v=20260824u";
import { CASES } from "./cases.js?v=20260824u";

const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

const state = {
  source: "range", mode: "blank", weight: "normal",
  scopeIndex: 0, fieldIndex: -1,
  showHint: true, emphasizeEnding: true,
  index: new Map(),      // lawId -> groups
  drill: null, article: null, ref: null, revealed: false,
  recent: [],            // 直近に出した条文（繰り返しを避ける）
  lastDoctrine: null,
  kase: null,            // 出題中の事例問題
  recentCases: [],       // 直近に出した事例問題のid
};

const RECENT_LIMIT = 40;
const refKey = ref => ref.law.id + "|" + ref.num;
function noteDrawn(ref) {
  const k = refKey(ref);
  state.recent = [k, ...state.recent.filter(x => x !== k)].slice(0, RECENT_LIMIT);
}

const MODE_NOTE = {
  blank:       "条文の一部を空欄にします。",
  descriptive: "条件節を残し、条文の効果部分を40字程度で書かせます。",
  case:        "本試験の記述式と同じ形式です。事例を読んで40字程度で答え、要素ごとの部分点で20点満点の採点をします。まだ解いていない問題と、前回の得点が低かった問題を重めに出します。",
  doctrine:    "Wikibooks の解説欄から判例法理を出題します。編集者による記述のため、条文と違い誤りを含む可能性があります。",
  recall:      "条見出しだけを頼りに、条文全体を書き起こします。",
};

/* 出題面に出す形式名。いま何を解いているのかを問題側にも表示する */
const MODE_LABEL = {
  blank: "穴埋め", descriptive: "条文40字", case: "事例記述",
  doctrine: "判例法理", recall: "全文再現",
};

/* ── 初期化 ── */
function initControls() {
  $("#scope").innerHTML = SCOPES.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
  $("#manualLaw").innerHTML = Object.values(LAWS).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("");

  bindSeg("#segSource", v => { state.source = v; syncPanes(); });
  bindSeg("#segMode",   v => { state.mode = v; syncPanes(); });
  bindSeg("#segWeight", v => { state.weight = v; });

  bindSwitch("#optHint",   v => { state.showHint = v; });
  bindSwitch("#optEnding", v => { state.emphasizeEnding = v; });

  $("#scope").addEventListener("change", e => {
    state.scopeIndex = +e.target.value; state.fieldIndex = -1; syncFields();
  });
  $("#field").addEventListener("change", e => { state.fieldIndex = +e.target.value; });
  $("#loadScope").addEventListener("click", loadScope);
  $("#draw").addEventListener("click", draw);

  $("#start").addEventListener("click", () => {
    document.body.classList.remove("covered");
    window.scrollTo(0, 0);
    $("#cover").classList.add("hide");
    setTimeout(() => { const c = $("#cover"); if (c) c.remove(); }, 500);
  });
  $("#logSave").addEventListener("click", saveLogFile);
  $("#logClear").addEventListener("click", () => {
    if (!confirm("たまっている解答の記録を消去します。よろしいですか。")) return;
    try { localStorage.removeItem(LOG_KEY); } catch (e) {}
    syncLogPanel();
  });
  syncLogPanel();

  // 読み込まれているスクリプトの版。古いものが残っていないか画面から確かめられる
  const v = $("#version");
  if (v) v.textContent = "版 " + VERSION + "（形式：" + Object.values(MODE_LABEL).join("・") + "）";

  syncPanes(); syncFields();
}

function bindSeg(sel, fn) {
  const root = $(sel);
  root.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    [...root.children].forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    fn(b.dataset.v);
  });
}
function bindSwitch(sel, fn) {
  const b = $(sel).querySelector(".sw");
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on)); fn(on);
  });
}

function syncPanes() {
  // 事例記述は自前の問題バンクから出すので、出題元の選択は使わない
  const isCase = state.mode === "case";
  $("#sourceLabel").hidden = isCase;
  $("#segSource").hidden  = isCase;
  $("#paneRange").hidden  = isCase || state.source !== "range";
  $("#paneNumber").hidden = isCase || state.source === "range";
  $("#modeNote").textContent = MODE_NOTE[state.mode];
  $("#modeNote").className = "hint" + (state.mode === "doctrine" ? " warn" : "");
  $("#optHint").hidden   = isCase || state.mode === "recall";
  $("#optEnding").hidden = state.mode !== "blank";
  $("#endingNote").hidden = state.mode !== "blank";
}

const currentScope = () => SCOPES[state.scopeIndex];
const scopeReady = () => currentScope().laws.every(l => state.index.has(l.id));
const availableFields = () => currentScope().laws.flatMap(l => state.index.get(l.id) || []);

function syncFields() {
  const ready = scopeReady();
  $("#loadScope").hidden = ready;
  $("#fieldRow").hidden = !ready;
  if (!ready) return;
  const fields = availableFields();
  const total = fields.reduce((a, g) => a + g.articles.length, 0);
  $("#field").innerHTML =
    `<option value="-1">範囲全体（${total.toLocaleString()}条）</option>` +
    fields.map((g, i) => `<option value="${i}">${esc(g.lawName + " ＞ " + g.path)}（${g.articles.length}）</option>`).join("");
  $("#field").value = String(state.fieldIndex);
}

function setStatus(html) { $("#status").innerHTML = html; }

async function loadScope() {
  const scope = currentScope();
  $("#loadScope").disabled = true;
  try {
    for (const [i, law] of scope.laws.entries()) {
      if (state.index.has(law.id)) continue;
      setStatus(`<p class="msg info"><span class="spin"></span> ${esc(law.name)}を読み込み中…（${i+1}/${scope.laws.length}）</p>`);
      state.index.set(law.id, await fetchIndex(law));
    }
    setStatus("");
    syncFields();
  } catch (e) {
    setStatus(`<p class="msg err">読み込めませんでした。${esc(e.message)}<br>通信を確認して、もう一度お試しください。</p>`);
  } finally {
    $("#loadScope").disabled = false;
  }
}

function candidateRefs() {
  const scope = currentScope();
  if (state.fieldIndex >= 0) {
    const g = availableFields()[state.fieldIndex];
    return g ? g.articles.map(n => ({law:g.law, num:n})) : [];
  }
  const out = [];
  for (const law of scope.laws) {
    for (const g of state.index.get(law.id) || []) {
      for (const n of g.articles) out.push({law, num:n});
    }
  }
  return out;
}

const MULTIPLIER = {flat:[1,1,1,1], normal:[1,2,4,7], focused:[1,3,9,20]};
function drawRef(refs) {
  const m = MULTIPLIER[state.weight];
  const recent = new Set(state.recent);
  // 直近に出した条文は 1/25 に減らす。候補が少ない分野でも詰まらないよう 0 にはしない。
  const weights = refs.map(r => {
    const w = weightOf(r.law.id, r.num);
    const base = m[Math.min(Math.max(w ? w.weight : 0, 0), 3)];
    return recent.has(refKey(r)) ? base / 25 : base;
  });
  return weightedPick(refs, weights);
}

async function draw() {
  $("#draw").disabled = true;
  state.revealed = false;
  $("#cases").hidden = true; $("#cases").innerHTML = "";
  setStatus(`<p class="msg info"><span class="spin"></span> 条文を取得中…</p>`);

  try {
    if (state.mode === "case") { await presentCase(); return; }
    if (state.source === "number") {
      const id = $("#manualLaw").value;
      const law = Object.values(LAWS).find(l => l.id === id);
      await present({law, num: $("#articleNo").value.trim()}, true);
      return;
    }
    let ref_;
    const refs = candidateRefs();
    if (!refs.length) {
      setStatus(`<p class="msg err">先に「この範囲を読み込む」を押してください。</p>`);
      return;
    }
    const reasons = [];
    for (let i = 0; i < 8; i++) {
      const r = await present(ref_ = drawRef(refs), false);
      if (r.ok) return;
      if (r.reason) reasons.push(r.reason);
      await new Promise(res => setTimeout(res, 120));   // e-Gov に連続でぶつけない
    }
    setStatus(`<p class="msg err">出題できる条文が見つかりませんでした。試した条文と理由：<br>`
      + reasons.map(x => "・" + esc(x)).join("<br>") + `</p>`);
  } catch (e) {
    setStatus(`<p class="msg err">${esc(e.message)}</p>`);
  } finally {
    $("#draw").disabled = false;
  }
}

/* ── 事例記述 ── */

/** 解答の記録から、事例問題ごとの直近の得点率を読む。
    記録は古い順に並んでいるので、後の記録で上書きされて最新のものが残る。
    空欄のまま採点したものは実力を表さないので数えない。 */
function caseScores() {
  const m = new Map();
  for (const text of readLog()) {
    const id  = (/\[([^\]]+)\]/.exec(text) || [])[1];
    const len = +((/私の解答\((\d+)字\)/.exec(text) || [])[1]);
    const sc  = /得点:\s*(\d+)\/(\d+)/.exec(text);
    if (!id || !sc || !len || !+sc[2]) continue;
    m.set(id, +sc[1] / +sc[2]);
  }
  return m;
}

/* 苦手なものほど出やすくする。まだ解いていないものがいちばん重い。
   条文モードの重要度（MULTIPLIER）と同じ考え方。 */
function caseWeight(pct) {
  if (pct === undefined) return 8;   // 未出題
  if (pct < 0.4) return 6;
  if (pct < 0.7) return 3;
  if (pct < 1)   return 2;
  return 1;                          // 満点だったものは控えめに
}

/** 直近に出したものを避け、苦手なものを重めにして事例問題を1問選ぶ */
function drawCase() {
  const fresh = CASES.filter(c => !state.recentCases.includes(c.id));
  const pool = fresh.length ? fresh : CASES;
  const scores = caseScores();
  const c = weightedPick(pool, pool.map(x => caseWeight(scores.get(x.id))));
  state.recentCases = [c.id, ...state.recentCases.filter(x => x !== c.id)]
    .slice(0, Math.max(1, CASES.length - 1));
  return c;
}

async function presentCase() {
  const c = drawCase();
  state.kase = c;
  state.drill = {mode:"case", answer:c.answer, paragraphIndex:-1};

  // 根拠条文は採点後に添えるだけなので、取れなくても出題は続ける
  const law = Object.values(LAWS).find(l => l.id === c.lawId);
  state.ref = law ? {law, num:c.articles[0]} : null;
  state.article = null;
  if (law) {
    try { state.article = await fetchArticle(law, c.articles[0]); } catch (e) {}
  }

  setStatus("");
  renderSheet();
}

/** 1条文を出題する。{ok, reason} を返す */
async function present(ref, forced) {
  const tag = `${ref.law.name} 第${String(ref.num).replace(/_/g,"の")}条`;
  let article = null;
  try { article = await fetchArticle(ref.law, ref.num); }
  catch (e) {
    if (forced) {
      setStatus(`<p class="msg err">${esc(tag)}を取得できませんでした。<br>${esc(e.message)}</p>`);
      return {ok:true};
    }
    if (/接続できません/.test(e.message)) throw e;   // 通信断は引き直しても無駄
    return {ok:false, reason:`${tag}：${e.message}`};
  }

  let drill = null;
  if (state.mode === "doctrine") {
    let list = [];
    try { const w = await fetchWikitext(ref.law, ref.num); if (w) list = parseDoctrines(w); } catch (e) {}
    if (!list.length) {
      if (forced) { setStatus(`<p class="msg info">${esc(tag)}には解説欄の記述がありませんでした。</p>`); return {ok:true}; }
      return {ok:false, reason:`${tag}：解説欄に記述なし`};
    }
    const fresh = list.filter(x => x.statement !== state.lastDoctrine);
    const chosen = pick(fresh.length ? fresh : list);
    state.lastDoctrine = chosen.statement;
    drill = makeDoctrine(chosen, state.showHint, refKey(ref));
    if (!drill) return {ok:forced, reason:`${tag}：解説から空欄を作れず`};
  } else {
    if (!forced && isPoorQuestion(article, state.mode)) {
      return {ok:false, reason:`${tag}：出題に適さない条文`};
    }
    if (state.mode === "blank") {
      drill = makeBlank(article, state.showHint, state.emphasizeEnding, refKey(ref));
    } else if (state.mode === "descriptive") {
      drill = makeDescriptive(article, state.showHint, refKey(ref));
      // 条番号を指定された場合は、40字が作れなくても穴埋めに落として出す
      if (!drill && forced) {
        drill = makeBlank(article, state.showHint, true, refKey(ref));
        if (drill) drill.notice = "この条文は効果部分が40字に届かないため、穴埋めとして出題します。";
      }
    }
    else if (state.mode === "recall") {
      drill = {mode:"recall", answer:fullText(article), question:"この条文を書き起こしてください。", paragraphIndex:-1};
    } else {
      // 知らない形式を黙って全文再現に落とすと、原因の分からない出題になる。
      // 起きるとすれば index.html だけ新しくスクリプトが古い場合なので、そう伝える。
      setStatus(`<p class="msg err">形式「${esc(state.mode)}」を解釈できませんでした。`
        + `<br>古いスクリプトが残っている可能性があります。ページを再読み込みしてください。</p>`);
      return {ok:true};
    }
    if (!drill) {
      if (!forced) return {ok:false, reason:`${tag}：空欄を作れず`};
      // 黙って全文再現に化けると、なぜこの問題が出たのか分からなくなる
      drill = {mode:"recall", answer:fullText(article), question:"この条文を書き起こしてください。", paragraphIndex:-1,
               notice:"この条文は空欄にできる部分がないため、全文再現として出題します。"};
    }
  }

  state.article = article; state.ref = ref; state.drill = drill;
  noteDrawn(ref);
  setStatus(""); renderSheet();
  return {ok:true};
}

/* ── 出題面の描画 ── */
function renderSheet() {
  const {drill, article, ref} = state;
  let html;

  if (drill.mode === "case") {
    // 論点名は答えそのものなので、採点するまで伏せておく
    const c = state.kase;
    html = `
      <div class="artline">
        <span class="artno">記述式　${esc(c.field)}</span>
        <span class="artcap">40字程度・20点</span>
      </div>
      <div class="meta">
        <span class="modetag">${esc(MODE_LABEL.case)}</span>
        <span>事実関係を読んで設問に答えてください</span>
      </div>
      <div class="facts">${esc(c.facts)}</div>
      <div class="ask">${esc(c.question)}</div>`;
    return finishSheet(html, 40);
  }

  const w = weightOf(ref.law.id, ref.num);
  const stars = w ? "★".repeat(Math.min(w.weight, 3)) : "";
  const isDoctrine = drill.mode === "doctrine";

  const body = isDoctrine
    ? renderArticle(article, -1, null)   // 判例法理では条文を参照として添える
    : renderArticle(article, drill.paragraphIndex, drill.question);

  html = `
    <div class="artline">
      <span class="artno">${esc(ref.law.name)}　${esc(article.title)}</span>
      ${article.caption ? `<span class="artcap">${esc(article.caption)}</span>` : ""}
    </div>
    <div class="meta">
      <span class="modetag">${esc(MODE_LABEL[drill.mode] || drill.mode)}</span>
      ${stars ? `<span class="stars">${stars}</span><span>${esc(w.note)}</span>` : `<span>重要度は未設定</span>`}
    </div>`;

  // 形式が切り替わったときは理由を書く。黙って別形式になると混乱する
  if (drill.notice) html += `<p class="msg info">${esc(drill.notice)}</p>`;

  if (isDoctrine) {
    html += `<p class="label">空欄を埋めてください</p>
      <div class="jobun">${drill.topic ? `<span class="topic">${esc(drill.topic)}</span>` : ""}${drill.question}</div>
      <p class="label" style="margin-top:16px">参照条文</p>
      <div class="ref">${esc(body)}</div>`;
  } else if (drill.mode === "recall") {
    html += `<p class="label">条文を書き起こしてください</p>
      <div class="jobun">${esc(drill.question)}</div>`;
  } else {
    html += `<p class="label">空欄を埋めてください</p>
      <div class="jobun">${body}</div>`;
  }

  const target = drill.mode === "descriptive" ? 40 : Math.max(20, Math.min(60, drill.answer.length + 8));
  finishSheet(html, target);
}

/** 解答欄を付けて出題面を確定する（どの形式でも共通） */
function finishSheet(html, target) {
  html += `
    <div class="answer">
      <textarea id="input" rows="3" placeholder="解答を入力"></textarea>
      <div class="grid" id="grid" data-target="${target}"></div>
      <div class="count"><span>解答欄は${target}マス</span><span><b id="count">0</b> 字</span></div>
      <button class="primary" id="grade" style="margin-top:16px">採点する</button>
    </div>
    <div id="result"></div>`;

  const sheet = $("#sheet");
  sheet.innerHTML = html;
  sheet.hidden = false;

  const ta = $("#input");
  ta.addEventListener("input", updateGrid);
  ta.focus();
  updateGrid();
  $("#grade").addEventListener("click", grade);
  sheet.scrollIntoView({behavior:"smooth", block:"start"});

  // 判例はオプションの直前に置く。採点前でも参照できる。
  const box = $("#cases");
  if (state.ref) {
    box.hidden = false;
    box.innerHTML = `<button class="ghost" id="cases-btn">この条文の判例を見る</button>`;
    $("#cases-btn").addEventListener("click", loadCases);
  } else {
    box.hidden = true;
    box.innerHTML = "";
  }
}

/** 解答用紙のマス目を書き換える */
function updateGrid() {
  const ta = $("#input"), grid = $("#grid");
  if (!ta || !grid) return;
  const target = +grid.dataset.target;
  const chars = [...ta.value.replace(/\n/g, "")];
  const cells = Math.max(target, Math.ceil(chars.length / 20) * 20);
  let html = "";
  for (let i = 0; i < cells; i++) {
    const over = i >= target;
    const tenth = (i % 20) === 9 ? " tenth" : "";
    html += `<div class="cell${over ? " over" : ""}${tenth}">${chars[i] ? esc(chars[i]) : ""}</div>`;
  }
  grid.innerHTML = html;
  const c = $("#count");
  c.textContent = chars.length;
  c.className = chars.length > target ? "over" : "";
}

/* ── 採点 ── */
function grade() {
  const {drill, article, ref} = state;
  const input = $("#input").value;
  state.revealed = true;

  if (drill.mode === "case") { gradeCase(input); return; }

  const pct = Math.round(similarity(input, drill.answer) * 100);
  const cls = pct >= 80 ? "hi" : pct >= 50 ? "mid" : "lo";

  let html = `
    <div class="score"><span class="label" style="margin:0">一致率</span>
      <span class="n ${cls}">${pct}<span style="font-size:18px">%</span></span></div>
    <p class="label">${drill.mode === "recall" ? "正解" : "空欄の正解"}</p>
    <div class="answerbox">${esc(drill.answer)}</div>`;

  if (drill.mode !== "doctrine" && drill.mode !== "recall") {
    html += `<p class="label" style="margin-top:16px">条文全体</p>
      <div class="ref">${esc(fullText(article))}</div>`;
  }
  showResult(html);
}

/** commentary の **強調** を太字にする。esc を通したあとに掛けるので、
    解説文以外のものが紛れ込むことはない */
const bold = t => t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

/** なぜその要素に点が入った（入らなかった）のかを一文で返す */
function reason(d) {
  if (d.implied) return `「${d.impliedFrom}」を書いた時点で含まれているものとして加点`;
  if (d.hit && d.match) {
    const how = d.match.how ? `（${d.match.how}照合）` : "";
    const sp  = d.match.spread ? "（語の割り込みを許して照合）" : "";
    return `解答の「${d.match.text}」が該当${how}${sp}`;
  }
  if (!d.hit && d.example) return `例：${d.example}`;
  return "";
}

/** 事例記述の採点。本試験と同じ要素ごとの部分点で20点満点 */
function gradeCase(input) {
  const c = state.kase;
  const s = scoreCase(input, c.points);
  const cls = s.pct >= 80 ? "hi" : s.pct >= 50 ? "mid" : "lo";

  let html = `
    <div class="score"><span class="label" style="margin:0">得点</span>
      <span class="n ${cls}">${s.earned}<span style="font-size:18px">/${s.full}点</span></span></div>
    <p class="topicline">${esc(c.topic)}</p>
    <p class="label">採点要素</p>
    <div class="points">` +
    s.detail.map(d => `
      <div class="point ${d.hit ? "hit" : "miss"}">
        <span class="mk">${d.hit ? "○" : "×"}</span>
        <span class="lb">${esc(d.label)}${
          // 加点した要素はその根拠を、落ちた要素はどう書けば得点になったのかを示す
          reason(d) ? `<span class="${d.hit ? "why" : "eg"}">${esc(reason(d))}</span>` : ""}</span>
        <span class="pt">${d.hit ? "+" : ""}${d.hit ? d.point : 0} / ${d.point}</span>
      </div>`).join("") + `
    </div>
    <p class="label" style="margin-top:16px">解答例（${c.answer.length}字）</p>
    <div class="answerbox">${esc(c.answer)}</div>` +
    (c.variant ? `<p class="label" style="margin-top:12px">別解（${c.variant.length}字）</p>
    <div class="answerbox alt">${esc(c.variant)}</div>` : "") + `
    <div class="commentary">${bold(esc(c.commentary))}</div>`;

  if (state.article) {
    html += `<p class="label" style="margin-top:16px">根拠条文</p>
      <div class="ref">${esc(fullText(state.article))}</div>`;
  }
  html += `
    <p class="hint">キーワードの有無による機械採点です。要素が入っていても文意が通らなければ本試験では得点になりません。解答例と読み比べてください。</p>
    <button class="ghost" id="copylog" style="margin-top:10px">この結果を記録用にコピー</button>
    <p class="hint" id="copymsg" hidden></p>`;

  // 採点のとりこぼしを報告してもらうための控え。採点した時点で自動的にためる。
  // 空欄のまま採点したものは記録しない。問題を見て回るための空打ちで記録が汚れると、
  // 苦手判定（caseScores）まで狂う
  state.lastLog = buildLog(c, s, input);
  if (input.trim()) appendLog(state.lastLog);
  showResult(html);
}

/** 記録ファイルに貼り付ける一件分のテキスト */
function buildLog(c, s, input) {
  const stamp = new Date().toLocaleString("ja-JP");
  return [
    "────────────────",
    `${stamp}　版 ${VERSION}`,
    `[${c.id}] ${c.topic}`,
    `設問: ${c.question}`,
    `私の解答(${[...input.replace(/\n/g, "")].length}字): ${input.trim()}`,
    `得点: ${s.earned}/${s.full}`,
    // 採点の当否をあとから検討できるよう、記録にも根拠を残す
    ...s.detail.flatMap(d => {
      const head = `  ${d.hit ? "○" : "×"} ${d.label}${d.implied ? "（含意）" : ""} (${d.hit ? d.point : 0}/${d.point})`;
      const why = reason(d);
      return why ? [head, `      ${why}`] : [head];
    }),
    `解答例: ${c.answer}`,
    "コメント: ",
    "",
  ].join("\n");
}

/* ══════════════════════════════════════════════
   解答の記録

   採点するたびに1件ずつ端末内（localStorage）にためて、
   まとめて1つのテキストファイルとして書き出す。
   クリップボード経由だと貼り付け先で保存する手間が要るため、
   ファイルとして直接受け取れるようにしている。
   ══════════════════════════════════════════════ */
const LOG_KEY = "jobun-answer-log";
const LOG_MAX = 300;

function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch (e) { return []; }
}
function appendLog(text) {
  try {
    const a = readLog();
    a.push(text);
    localStorage.setItem(LOG_KEY, JSON.stringify(a.slice(-LOG_MAX)));
  } catch (e) {}   // 保存できない設定でも出題は続けられるようにする
  syncLogPanel();
}
function syncLogPanel() {
  const c = $("#logCount");
  if (!c) return;
  const n = readLog().length;
  // 記録は苦手判定にも使うので、いま何問が未着手・何問が苦手扱いなのかも見せる
  const scores = caseScores();
  const weak = CASES.filter(x => (scores.get(x.id) ?? 0) < 0.7).length;
  const done = scores.size;
  c.textContent = n
    ? `${n}件たまっています。ファイルに保存して渡してください。`
      + `（${CASES.length}問中${done}問を解答済み、うち重点は${weak}問）`
    : "事例記述を採点すると、ここに1件ずつたまります。";
  $("#logSave").disabled = !n;
  $("#logClear").disabled = !n;
}

const two = n => String(n).padStart(2, "0");
function fileStamp(d) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

function saveLogFile() {
  const a = readLog();
  if (!a.length) return;
  const now = new Date();
  const head = "條文ドリル｜解答の記録\n"
    + `書き出し ${now.toLocaleString("ja-JP")}　版 ${VERSION}　${a.length}件\n`
    + "各件の「コメント:」に気づいたことを書き足してから渡してください。\n"
    + "・×だが内容は合っているはず → 採点のとりこぼしです\n"
    + "・○だが実は分かっていなかった → 採点が甘すぎます\n"
    + "・解説や問題文の誤り、設問の分かりにくさ\n\n";
  // 先頭のBOMは、メモ帳などで文字化けさせないため
  const blob = new Blob(["﻿" + head + a.join("\n")], {type:"text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `jobun-log-${fileStamp(now)}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** クリップボードへ。HTTPS でない場合などのために古い方法も残す */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  return ok;
}

/** 採点結果を表示して「もう一問」を配線する */
function showResult(html) {
  html += `
    <div style="margin-top:18px">
      <button class="primary" id="next">もう一問</button>
    </div>`;
  $("#result").innerHTML = html;
  $("#grade").disabled = true;
  $("#next").addEventListener("click", draw);

  const copy = $("#copylog");
  if (copy) {
    copy.addEventListener("click", async () => {
      const ok = await copyText(state.lastLog || "");
      const msg = $("#copymsg");
      msg.hidden = false;
      msg.className = "hint" + (ok ? "" : " warn");
      msg.textContent = ok
        ? "コピーしました。記録ファイルに貼り付けてください。"
        : "コピーできませんでした。下の解答例ごと選択して手動でコピーしてください。";
    });
  }
  $("#result").scrollIntoView({behavior:"smooth", block:"nearest"});
}

/* ── 判例 ── */
async function loadCases() {
  const {ref} = state;
  const box = $("#cases");
  box.hidden = false;
  box.innerHTML = `<p class="msg info"><span class="spin"></span> 判例を取得中…</p>`;
  try {
    const w = await fetchWikitext(ref.law, ref.num);
    const list = w ? parsePrecedents(w) : [];
    const url = wikiURL(ref.law, ref.num);
    if (!list.length) {
      box.innerHTML = `<p class="msg info">この条文には判例の記載がありませんでした。`
        + (url ? ` <a href="${url}" target="_blank" rel="noopener">Wikibooksで開く</a>` : "") + `</p>`;
      return;
    }
    box.innerHTML = `<p class="eyebrow">判例</p>` + list.map(p => `
      <div class="case">
        ${p.link ? `<a href="${p.link}" target="_blank" rel="noopener">${esc(p.title)} ↗</a>`
                 : `<span style="font-size:14.5px;font-weight:600">${esc(p.title)}</span>`}
        ${p.summary ? `<p>${esc(p.summary)}</p>` : ""}
      </div>`).join("")
      + (url ? `<button class="ghost" onclick="window.open('${url}','_blank')">Wikibooks でこの条文の解説を開く</button>
               <p class="hint">出典：Wikibooks コンメンタール（CC BY-SA）</p>` : "");
    box.scrollIntoView({behavior:"smooth", block:"nearest"});
  } catch (e) {
    box.innerHTML = `<p class="msg err">判例を取得できませんでした。${esc(e.message)}</p>`;
  }
}

initControls();
