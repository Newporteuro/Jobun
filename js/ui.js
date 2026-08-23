/* ══════════════════════════════════════════════
   画面表示

   操作卓の状態を持ち、取得（sources）と出題（drill）を呼び分けて、
   結果を DOM に書く。アプリの入口でもある（末尾で initControls）。
   ══════════════════════════════════════════════ */
import { LAWS, SCOPES, weightOf } from "./weights.js";
import {
  fetchArticle, fetchIndex, renderArticle, fullText,
  fetchWikitext, parsePrecedents, parseDoctrines, wikiURL,
} from "./sources.js";
import {
  makeBlank, makeDescriptive, makeDoctrine,
  isPoorQuestion, similarity, weightedPick, pick,
} from "./drill.js";

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
};

const RECENT_LIMIT = 40;
const refKey = ref => ref.law.id + "|" + ref.num;
function noteDrawn(ref) {
  const k = refKey(ref);
  state.recent = [k, ...state.recent.filter(x => x !== k)].slice(0, RECENT_LIMIT);
}

const MODE_NOTE = {
  blank:       "条文の一部を空欄にします。",
  descriptive: "本試験と同じ40字前後になるよう、文末までをまとめて空欄にします。",
  doctrine:    "Wikibooks の解説欄から判例法理を出題します。編集者による記述のため、条文と違い誤りを含む可能性があります。",
  recall:      "条見出しだけを頼りに、条文全体を書き起こします。",
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
  $("#paneRange").hidden  = state.source !== "range";
  $("#paneNumber").hidden = state.source === "range";
  $("#modeNote").textContent = MODE_NOTE[state.mode];
  $("#modeNote").className = "hint" + (state.mode === "doctrine" ? " warn" : "");
  $("#optHint").hidden   = state.mode === "recall";
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
    if (state.mode === "blank")            drill = makeBlank(article, state.showHint, state.emphasizeEnding, refKey(ref));
    else if (state.mode === "descriptive") drill = makeDescriptive(article, state.showHint, refKey(ref));
    else drill = {mode:"recall", answer:fullText(article), question:"この条文を書き起こしてください。", paragraphIndex:-1};
    if (!drill) {
      if (!forced) return {ok:false, reason:`${tag}：空欄を作れず`};
      drill = {mode:"recall", answer:fullText(article), question:"この条文を書き起こしてください。", paragraphIndex:-1};
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
  const w = weightOf(ref.law.id, ref.num);
  const stars = w ? "★".repeat(Math.min(w.weight, 3)) : "";
  const isDoctrine = drill.mode === "doctrine";

  const body = isDoctrine
    ? renderArticle(article, -1, null)   // 判例法理では条文を参照として添える
    : renderArticle(article, drill.paragraphIndex, drill.question);

  let html = `
    <div class="artline">
      <span class="artno">${esc(ref.law.name)}　${esc(article.title)}</span>
      ${article.caption ? `<span class="artcap">${esc(article.caption)}</span>` : ""}
    </div>
    <div class="meta">
      ${stars ? `<span class="stars">${stars}</span><span>${esc(w.note)}</span>` : `<span>重要度は未設定</span>`}
    </div>`;

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
  box.hidden = false;
  box.innerHTML = `<button class="ghost" id="cases-btn">この条文の判例を見る</button>`;
  $("#cases-btn").addEventListener("click", loadCases);
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
  const pct = Math.round(similarity(input, drill.answer) * 100);
  const cls = pct >= 80 ? "hi" : pct >= 50 ? "mid" : "lo";
  state.revealed = true;

  let html = `
    <div class="score"><span class="label" style="margin:0">一致率</span>
      <span class="n ${cls}">${pct}<span style="font-size:18px">%</span></span></div>
    <p class="label">${drill.mode === "recall" ? "正解" : "空欄の正解"}</p>
    <div class="answerbox">${esc(drill.answer)}</div>`;

  if (drill.mode !== "doctrine" && drill.mode !== "recall") {
    html += `<p class="label" style="margin-top:16px">条文全体</p>
      <div class="ref">${esc(fullText(article))}</div>`;
  }
  html += `
    <div style="margin-top:18px">
      <button class="primary" id="next">もう一問</button>
    </div>`;

  $("#result").innerHTML = html;
  $("#grade").disabled = true;
  $("#next").addEventListener("click", draw);
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
