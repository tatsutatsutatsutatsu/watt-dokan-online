/* ワットでドカン！-CARD BATTLE- 対戦サーバー（サーバー権威型）
 * 起動: node server.js  （ポート変更: PORT=3002 node server.js）
 * 依存: npm install ws
 *
 * サーバーがゲームの全ロジック（カードプール／ターン進行／攻撃判定／
 * マリガン／ファティーグ／ターンタイマー）を管理し、クライアントは
 * 操作を送って自分視点のスナップショットを受け取るだけの薄いビューになる。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;
const TURN_MS = 90000;              // ターンタイマー：90秒
const MULLIGAN_MS = 25000;          // マリガン制限時間
const RECONNECT_GRACE_MS = 120000;  // 再接続猶予：2分

/* ==================== 静的ファイル配信 (public/) ==================== */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  const reqUrl = req.url.split("?")[0];

  // カードプール表示用データ配信（クライアント側でPOOLをハードコード複製しないための唯一の情報源）
  if (reqUrl === "/cards") {
    const data = POOL.map(c => ({ id:c.id, n:c.n, e:c.e, c:c.c, t:c.t, a:c.a, h:c.h, kw:c.kw, tx:c.tx, type:c.type }));
    // no-store：古いレスポンス（idなし時代等）がブラウザキャッシュから返るのを防ぐ
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
    return;
  }

  const url = reqUrl === "/" ? "/index.html" : reqUrl;
  const fp = path.join(__dirname, "public", path.normalize(url).replace(/^(\.\.[\/\\])+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ==================== カードプール（コスト＝ワット数、ルール変更なし） ==================== */
/* id はデッキ構築でカードを特定するための安定した文字列キー。表示内容が変わってもidは変えないこと。 */
const POOL = [
 {id:"led",n:"LED電球",e:"💡",c:100,t:"f",a:1,h:1,fx:"draw1",tx:"設置時：1枚ドロー",type:"設備"},
 {id:"charger",n:"スマホ充電器",e:"🔋",c:100,t:"f",a:1,h:2,tx:"",type:"工具"},
 {id:"fan",n:"扇風機",e:"🌀",c:200,t:"f",a:2,h:1,tx:"",type:"設備"},
 {id:"tester",n:"検電器",e:"🖊️",c:200,t:"f",a:1,h:1,kw:"突進",tx:"突進：設置ターンに家電を攻撃可",type:"工具"},
 {id:"fridge",n:"冷蔵庫",e:"🧊",c:300,t:"f",a:2,h:3,kw:"守護",tx:"守護：先に攻撃を受け止める",type:"設備"},
 {id:"drill",n:"電気ドリル",e:"🛠️",c:300,t:"f",a:3,h:2,tx:"",type:"工具"},
 {id:"washer",n:"洗濯機",e:"🫧",c:500,t:"f",a:4,h:4,tx:"",type:"水力"},
 {id:"microwave",n:"電子レンジ",e:"⚡",c:600,t:"f",a:5,h:4,tx:"",type:"火力"},
 {id:"dryer",n:"ドライヤー",e:"💨",c:700,t:"f",a:4,h:3,kw:"疾走",tx:"疾走：設置ターンからリーダーも攻撃可",type:"火力"},
 {id:"aircon",n:"エアコン",e:"❄️",c:800,t:"f",a:5,h:6,kw:"守護",tx:"守護：先に攻撃を受け止める",type:"設備"},
 {id:"cubicle",n:"キュービクル",e:"🏭",c:900,t:"f",a:7,h:7,kw:"守護",tx:"守護：高圧受電設備の壁",type:"設備"},
 {id:"transformer",n:"特高変圧器",e:"🗼",c:1000,t:"f",a:9,h:9,tx:"フィニッシャー",type:"設備"},
 {id:"ground",n:"アース接地",e:"🌱",c:200,t:"s",fx:"heal3",tx:"自分のリーダーを3回復",type:"再エネ"},
 {id:"short",n:"ショート",e:"🔥",c:300,t:"s",fx:"dmg3",tg:1,tx:"敵の家電1台に3ダメージ",type:"火力"},
 {id:"wiring",n:"配線工事",e:"🔧",c:300,t:"s",fx:"draw2",tx:"カードを2枚引く",type:"工具"},
 {id:"solar",n:"ソーラーパネル",e:"☀️",c:400,t:"s",fx:"ramp",tx:"最大電力を+200W",type:"再エネ"},
 {id:"breaker",n:"漏電遮断器",e:"🔌",c:600,t:"s",fx:"kill",tg:1,tx:"敵の家電1台を遮断（破壊）",type:"設備"},
 {id:"surge",n:"雷サージ",e:"🌩️",c:800,t:"s",fx:"aoe3",tx:"敵の家電全体に3ダメージ",type:"火力"},
 {id:"fuse",n:"ヒューズ",e:"🔩",c:200,t:"f",a:1,h:2,kw:"ラストワード",lw:"draw1",tx:"ラストワード：カードを1枚引く",type:"工具"},
 {id:"capacitor",n:"コンデンサ",e:"⚡",c:400,t:"f",a:2,h:3,kw:"ラストワード",lw:"dmg2rand",tx:"ラストワード：ランダムな敵フォロワー1体に2ダメージ",type:"工具"},
 {id:"generator",n:"予備発電機",e:"⛽",c:500,t:"f",a:3,h:3,kw:"ラストワード",lw:"heal2",tx:"ラストワード：自リーダーを2回復",type:"火力"},
 {id:"megger",n:"メガー(絶縁抵抗計)",e:"📟",c:500,t:"f",a:2,h:2,kw:"必殺",tx:"必殺：この家電の攻撃でダメージを受けた敵は破壊される",type:"工具"},
 {id:"charge_station",n:"充電ステーション",e:"🔌",c:600,t:"f",a:4,h:4,kw:"ドレイン",tx:"ドレイン：攻撃で与えたダメージ分、自リーダーを回復",type:"設備"},
 {id:"kickboard",n:"電動キックボード",e:"🛴",c:400,t:"f",a:2,h:2,kw:"疾走",tx:"疾走：設置ターンからリーダーも攻撃可",type:"工具"},
 {id:"panelboard",n:"分電盤",e:"🗄️",c:600,t:"f",a:3,h:6,kw:"守護",tx:"守護：先に攻撃を受け止める",type:"設備"},
 {id:"lightning_rod",n:"避雷針",e:"📡",c:200,t:"f",a:1,h:3,kw:"守護",tx:"守護：先に攻撃を受け止める",type:"設備"},
 {id:"voltage_transformer",n:"変圧器",e:"🔃",c:700,t:"f",a:3,h:3,fx:"buffall1atk",tx:"ファンファーレ：味方フォロワー全体を+1/+0",type:"設備"},
 {id:"solar_plant",n:"太陽光発電所",e:"🌞",c:900,t:"f",a:6,h:6,fx:"wrefill300",tx:"設置時：このターンの電力+300W",type:"再エネ"},
 {id:"electrician1",n:"第一種電気工事士",e:"👷",c:1000,t:"f",a:7,h:7,fx:"aoe2",tx:"ファンファーレ：敵フォロワー全体に2ダメージ",type:"作業員"},
 {id:"octopus_wiring",n:"タコ足配線",e:"🐙",c:300,t:"s",fx:"tacoashi",tx:"コンセント(1/1・効果なし)を2体設置（盤面上限4は超えない）",type:"工具"},
];
const POOL_BY_ID = new Map(POOL.map(c => [c.id, c]));
const TOKEN_OUTLET = { n:"コンセント", e:"🔌", c:0, t:"f", a:1, h:1, tx:"" };
const MAXW = 1000, BOARD_MAX = 4, HAND_MAX = 8;
const EVO = { A:{turn:5,ep:2}, B:{turn:4,ep:3} }; // 先攻:5T/EP2 後攻:4T/EP3

/* ==================== デッキ構築 ==================== */
const DECK_SIZE = 20;
/* デフォルトデッキ：30種のカードプールからバランス良く20枚を採用。不正デッキの代替として使用。 */
const DEFAULT_DECK = [
  "led","led","charger","fuse","fuse","ground",
  "fridge","drill","short","wiring",
  "capacitor","capacitor","kickboard",
  "megger","generator",
  "charge_station","panelboard",
  "voltage_transformer",
  "solar_plant",
  "electrician1",
];
function validateDeck(idsRaw) {
  if (!Array.isArray(idsRaw) || idsRaw.length !== DECK_SIZE) return null;
  const counts = new Map();
  for (const id of idsRaw) {
    if (typeof id !== "string" || !POOL_BY_ID.has(id)) return null;
    const n = (counts.get(id) || 0) + 1;
    if (n > 2) return null;
    counts.set(id, n);
  }
  return idsRaw.slice();
}
function resolveDeck(idsRaw) {
  const v = validateDeck(idsRaw);
  if (!v) {
    console.log("⚠ 不正なデッキを受信 → デフォルトデッキで代替:", JSON.stringify(idsRaw));
    return DEFAULT_DECK.slice();
  }
  return v;
}
function randomValidDeck() {
  const bag = POOL.flatMap(c => [c.id, c.id]); // 2枚ずつの36枚バッグ
  shuffle(bag);
  return bag.slice(0, DECK_SIZE);
}

/* ==================== ユーティリティ ==================== */
const shuffle = a => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const other = s => s === "A" ? "B" : "A";
const genToken = () => crypto.randomBytes(16).toString("hex");
function genCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function cleanName(s) {
  return String(s || "").slice(0, 8).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
const send = (ws, obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

/* ==================== ルーム管理 ==================== */
const rooms = new Map(); // code -> room

function makeRoom(code, cpu) {
  return {
    code, cpu: !!cpu,
    seats: { A: null, B: null }, // {ws,name,token,connected,isCpu}
    G: null, epoch: 0,
    turnTimer: null, mulliganTimer: null, overTimer: null,
    disconnectTimers: { A: null, B: null },
    rematch: { A: false, B: false },
    cpuBusy: false,
  };
}

/* ==================== ゲームエンジン ==================== */
function mkSide(deckIds) {
  return { hp:20, maxW:0, w:0, ep:0, tn:0, epGiven:false, fatigue:0, mulliganDone:false,
    deck: shuffle(deckIds.map(id => ({ ...POOL_BY_ID.get(id) }))), hand:[], board:[] };
}

function setMsg(G, text) {
  G.msg = text;
  G.logList.unshift(text);
  if (G.logList.length > 40) G.logList.length = 40;
}
function drawN(G, seatX, n) {
  const s = G.S[seatX];
  for (let i=0;i<n;i++) {
    if (s.deck.length) {
      if (s.hand.length < HAND_MAX) s.hand.push(s.deck.pop());
    } else {
      s.fatigue = (s.fatigue||0) + 1;
      s.hp -= s.fatigue;
      setMsg(G, `${G.names[seatX]}：山札切れ！ファティーグダメージ${s.fatigue}`);
    }
  }
}
function summon(G, s, card) {
  // cid はカードの安定した文字列ID（アイコン画像 /icons/<cid>.png の特定に使用）。
  // id は盤面ユニットの一意な数値インスタンスIDで、...card 展開後に上書きされ card.id とは別物になる。
  const u = { ...card, cid: card.id, id: ++G.nextId, maxhp: card.h, hp: card.h, canAtk: card.kw==="疾走"||card.kw==="突進", rushOnly: card.kw==="突進", evolved:false };
  s.board.push(u);
  return u;
}
function fanfare(G, s, e, card) {
  if (card.fx === "draw1") drawN(G, s===G.S.A?"A":"B", 1);
  if (card.fx === "draw2") drawN(G, s===G.S.A?"A":"B", 2);
  if (card.fx === "heal3") s.hp = Math.min(20, s.hp + 3);
  if (card.fx === "ramp") s.maxW = Math.min(MAXW, s.maxW + 200);
  if (card.fx === "wrefill300") s.w = Math.min(s.maxW, s.w + 300);
  if (card.fx === "aoe3") e.board.forEach(u => u.hp -= 3);
  if (card.fx === "aoe2") e.board.forEach(u => u.hp -= 2);
  if (card.fx === "buffall1atk") s.board.forEach(u => u.a += 1);
  if (card.fx === "tacoashi") {
    const n = Math.min(2, BOARD_MAX - s.board.length);
    for (let i=0;i<n;i++) summon(G, s, TOKEN_OUTLET);
  }
}
/* ---- ラストワード：死亡ユニットの効果発動（連鎖対応・上限カウンタ付き） ---- */
function triggerLastword(G, seatX, u) {
  const s = G.S[seatX], e = G.S[other(seatX)];
  if (u.lw === "draw1") {
    drawN(G, seatX, 1);
    setMsg(G, `${G.names[seatX]}：${u.n}のラストワード発動！💀 カードを1枚引いた`);
  }
  else if (u.lw === "dmg2rand") {
    if (e.board.length) {
      const t = e.board[Math.floor(Math.random() * e.board.length)];
      t.hp -= 2;
      setMsg(G, `${G.names[seatX]}：${u.n}のラストワード発動！💀 ${t.n}に2ダメージ`);
    }
  }
  else if (u.lw === "heal2") {
    s.hp = Math.min(20, s.hp + 2);
    setMsg(G, `${G.names[seatX]}：${u.n}のラストワード発動！💀 自リーダーを2回復`);
  }
}
function processDeaths(room) {
  const G = room.G;
  let guard = 0;
  while (guard++ < 50) {
    const deadA = G.S.A.board.filter(u => u.hp <= 0).map(u => ({ u, seatX:"A" }));
    const deadB = G.S.B.board.filter(u => u.hp <= 0).map(u => ({ u, seatX:"B" }));
    const dead = [...deadA, ...deadB];
    if (!dead.length) break;
    G.S.A.board = G.S.A.board.filter(u => u.hp > 0);
    G.S.B.board = G.S.B.board.filter(u => u.hp > 0);
    dead.forEach(({ u, seatX }) => { if (u.kw === "ラストワード") triggerLastword(G, seatX, u); });
  }
}
function snapshotHP(G) {
  const m = { leaderA: G.S.A.hp, leaderB: G.S.B.hp };
  G.S.A.board.forEach(u => m["u"+u.id] = u.hp);
  G.S.B.board.forEach(u => m["u"+u.id] = u.hp);
  return m;
}
function diffHP(before, G) {
  const diffs = [], deaths = [];
  const after = { leaderA: G.S.A.hp, leaderB: G.S.B.hp };
  G.S.A.board.forEach(u => after["u"+u.id] = u.hp);
  G.S.B.board.forEach(u => after["u"+u.id] = u.hp);
  for (const key in before) {
    if (after[key] !== undefined) {
      const d = after[key] - before[key];
      if (d !== 0) diffs.push({ id:key, delta:d });
    } else {
      deaths.push({ id:key });
      if (before[key] > 0) diffs.push({ id:key, delta:-before[key] });
    }
  }
  return { diffs, deaths };
}
function pushEvent(G, ev) {
  G.eventSeq++;
  G.lastEvent = { id: G.eventSeq, ...ev };
}

function startTurn(room, seatX) {
  const G = room.G, s = G.S[seatX];
  G.active = seatX; s.tn++;
  s.maxW = Math.min(MAXW, s.maxW + 100); s.w = s.maxW;
  if (s.tn >= EVO[seatX].turn && s.ep === 0 && !s.epGiven) { s.ep = EVO[seatX].ep; s.epGiven = true; }
  s.board.forEach(u => { u.canAtk = true; u.rushOnly = false; });
  drawN(G, seatX, 1);
  setMsg(G, `― ${G.names[seatX]} のターン${s.tn} ―`);
  armTurnTimer(room);
}

function newGame(room, nameA, nameB) {
  room.epoch = (room.epoch||0) + 1;
  clearOverTimer(room);
  const G = {
    S: { A: mkSide(room.seats.A.deck), B: mkSide(room.seats.B.deck) },
    active: "A", msg: "マリガン：交換したいカードを選んでください", logList: [],
    phase: "mulligan", result: null,
    names: { A: nameA, B: nameB },
    nextId: 0, eventSeq: 0, lastEvent: null, deadline: null,
  };
  room.G = G;
  room.rematch = { A:false, B:false };
  drawN(G, "A", 3); drawN(G, "B", 4);
  room.cpuBusy = false;
  if (room.cpu) G.S.B.mulliganDone = true; // CPUはマリガンしない
  armMulliganTimer(room);
  broadcast(room);
}

function applyMulligan(room, seatX, idxRaw) {
  const G = room.G;
  if (!G || G.phase !== "mulligan") return;
  const me = G.S[seatX];
  if (me.mulliganDone) return;
  const idx = [...new Set((Array.isArray(idxRaw)?idxRaw:[]).filter(n => Number.isInteger(n) && n >= 0 && n < me.hand.length))];
  idx.sort((a,b) => b-a);
  const redrawn = idx.map(i => me.hand.splice(i,1)[0]);
  if (redrawn.length) {
    me.deck.push(...redrawn); shuffle(me.deck);
    drawN(G, seatX, redrawn.length);
  }
  me.mulliganDone = true;
  setMsg(G, `${G.names[seatX]}：マリガン完了（${redrawn.length}枚交換）`);
  pushEvent(G, { type:"mulligan", seat:seatX, count: redrawn.length, diffs:[], deaths:[] });

  if (G.S.A.mulliganDone && G.S.B.mulliganDone) {
    clearMulliganTimer(room);
    G.phase = "battle";
    const before = snapshotHP(G);
    startTurn(room, "A");
    const { diffs, deaths } = diffHP(before, G);
    pushEvent(G, { type:"turn", seat:"A", diffs, deaths });
  }
  broadcast(room);
}

function applyRetire(room, seatX) {
  const G = room.G;
  if (!G || G.result || (G.phase !== "battle" && G.phase !== "mulligan")) return;
  G.result = other(seatX);
  G.phase = "over"; G.deadline = null;
  clearTurnTimer(room); clearMulliganTimer(room);
  armOverTimer(room);
  setMsg(G, `${G.names[seatX]}がリタイアした`);
  pushEvent(G, { type:"retire", seat:seatX, diffs:[], deaths:[] });
  broadcast(room);
}

function applyAction(room, seatX, act) {
  const G = room.G;
  if (!G || G.phase !== "battle" || G.result || G.active !== seatX || !act || typeof act !== "object") return;
  const me = G.S[seatX], op = G.S[other(seatX)], nm = G.names[seatX];
  const before = snapshotHP(G);
  let evType = null, evMeta = {};

  if (act.a === "play" && Number.isInteger(act.hand)) {
    const card = me.hand[act.hand];
    if (!card || card.c > me.w) return;
    if (card.t === "f") {
      if (me.board.length >= BOARD_MAX) return;
      me.w -= card.c; me.hand.splice(act.hand,1);
      const u = summon(G, me, card); fanfare(G, me, op, card);
      setMsg(G, `${nm}：${card.n}を設置（${card.c}W）`);
      evType = "play"; evMeta = { seat:seatX, unitId:u.id, cardName:card.n };
    } else if (card.tg) {
      const t = op.board[act.ti]; if (!t) return;
      me.w -= card.c; me.hand.splice(act.hand,1);
      if (card.fx === "dmg3") t.hp -= 3;
      if (card.fx === "kill") t.hp = 0;
      setMsg(G, `${nm}：${card.n} → ${t.n}！`);
      evType = "spell"; evMeta = { seat:seatX, cardName:card.n, targetUnitId:t.id };
    } else {
      me.w -= card.c; me.hand.splice(act.hand,1); fanfare(G, me, op, card);
      setMsg(G, `${nm}：${card.n}を発動`);
      evType = "spell"; evMeta = { seat:seatX, cardName:card.n };
    }
  }
  else if (act.a === "evolve" && Number.isInteger(act.i)) {
    const u = me.board[act.i];
    if (!u || u.evolved || me.ep <= 0 || me.tn < EVO[seatX].turn) return;
    me.ep--; u.evolved = true; u.a += 2; u.hp += 2; u.maxhp += 2;
    if (!u.canAtk) { u.canAtk = true; u.rushOnly = true; }
    setMsg(G, `${nm}：${u.n}が進化！✨`);
    evType = "evolve"; evMeta = { seat:seatX, unitId:u.id };
  }
  else if (act.a === "attack" && Number.isInteger(act.i)) {
    const u = me.board[act.i]; if (!u || !u.canAtk) return;
    const guards = op.board.filter(x => x.kw === "守護");
    if (act.target === "leader") {
      if (guards.length || u.rushOnly) return;
      u.canAtk = false;
      const dmg = u.a;
      op.hp -= dmg;
      let atkMsg = `${nm}：${u.n}がリーダーに${dmg}ダメージ！💥`;
      if (u.kw === "ドレイン" && dmg > 0) { me.hp = Math.min(20, me.hp + dmg); atkMsg += `（🩸ドレインで${dmg}回復）`; }
      setMsg(G, atkMsg);
      evType = "attack"; evMeta = { seat:seatX, unitId:u.id, targetSeat: other(seatX), targetLeader:true };
    } else {
      const t = op.board[act.ti]; if (!t) return;
      if (guards.length && t.kw !== "守護") return;
      u.canAtk = false;
      const dmgToT = u.a, dmgToU = t.a;
      t.hp -= dmgToT; u.hp -= dmgToU;
      let atkMsg = `${nm}：${u.n} ⚔ ${t.n}`;
      if (u.kw === "ドレイン" && dmgToT > 0) { me.hp = Math.min(20, me.hp + dmgToT); atkMsg += `（🩸ドレインで${dmgToT}回復）`; }
      if (u.kw === "必殺" && dmgToT > 0) { t.hp = -1; atkMsg += `（☠️必殺で撃破）`; }
      setMsg(G, atkMsg);
      evType = "attack"; evMeta = { seat:seatX, unitId:u.id, targetSeat: other(seatX), targetUnitId:t.id };
    }
  }
  else if (act.a === "end") {
    startTurn(room, other(seatX));
    evType = "turn"; evMeta = { seat: other(seatX) };
  }
  else return;

  processDeaths(room);
  if (!G.result && (G.S.A.hp <= 0 || G.S.B.hp <= 0)) {
    G.result = G.S.A.hp <= 0 ? "B" : "A";
    G.phase = "over"; G.deadline = null;
    clearTurnTimer(room);
    armOverTimer(room);
    setMsg(G, `${G.names[G.result]}の勝利！`);
  }
  const { diffs, deaths } = diffHP(before, G);
  if (evType) pushEvent(G, { type:evType, diffs, deaths, ...evMeta });
  broadcast(room);

  if (room.cpu && G.phase === "battle" && G.active === "B" && !G.result && !room.cpuBusy) {
    room.cpuBusy = true;
    scheduleCpuTurn(room);
  }
}

function buildSnap(room, forSeat) {
  const G = room.G;
  const me = G.S[forSeat], op = G.S[other(forSeat)];
  const oppSeatKey = other(forSeat);
  const side = (s, seatTag) => ({
    hp:s.hp, maxW:s.maxW, w:s.w, ep:s.ep, tn:s.tn, deckN:s.deck.length,
    board: s.board.map(u => ({ id:u.id, cid:u.cid, seat:seatTag, n:u.n, e:u.e, a:u.a, hp:u.hp, maxhp:u.maxhp, kw:u.kw, evolved:u.evolved, canAtk:u.canAtk, rushOnly:u.rushOnly, c:u.c, tx:u.tx, type:u.type })),
  });
  const oppObj = room.seats[oppSeatKey];
  return {
    gameId: room.epoch,
    phase: G.phase,
    mySeat: forSeat,
    deadline: G.deadline || null,
    me: { ...side(me, forSeat), hand: me.hand, canEvolve: G.phase==="battle" && me.tn >= EVO[forSeat].turn && me.ep > 0, mulliganDone: !!me.mulliganDone },
    opp: { ...side(op, oppSeatKey), handN: op.hand.length, mulliganDone: !!op.mulliganDone },
    oppName: G.names[oppSeatKey], myName: G.names[forSeat],
    yourTurn: G.phase === "battle" && G.active === forSeat && !G.result,
    msg: G.msg, log: G.logList,
    event: G.lastEvent,
    result: G.result ? (G.result === forSeat ? "win" : "lose") : null,
    oppConnected: !!(oppObj && oppObj.connected),
  };
}
function broadcast(room) {
  if (!room.G) return;
  ["A","B"].forEach(seatX => {
    const seat = room.seats[seatX];
    if (seat && seat.ws && seat.connected) send(seat.ws, { type:"state", snap: buildSnap(room, seatX) });
  });
}

/* ---- ターン／マリガン／決着後 タイマー（epoch でルーム再戦後の古いタイマーを無効化） ---- */
const OVER_ROOM_MS = 10 * 60 * 1000; // 決着後、誰も再戦せず放置されたルームを10分で掃除
function clearTurnTimer(room) { if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; } }
function clearMulliganTimer(room) { if (room.mulliganTimer) { clearTimeout(room.mulliganTimer); room.mulliganTimer = null; } }
function clearOverTimer(room) { if (room.overTimer) { clearTimeout(room.overTimer); room.overTimer = null; } }
function armOverTimer(room) {
  clearOverTimer(room);
  const epoch = room.epoch;
  room.overTimer = setTimeout(() => {
    if (room.epoch !== epoch || !room.G || room.G.phase !== "over") return;
    clearTurnTimer(room); clearMulliganTimer(room);
    rooms.delete(room.code);
  }, OVER_ROOM_MS);
}
function armTurnTimer(room) {
  clearTurnTimer(room);
  const G = room.G, epoch = room.epoch;
  G.deadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    if (room.epoch !== epoch || !room.G || room.G.phase !== "battle" || room.G.result) return;
    applyAction(room, room.G.active, { a:"end" });
  }, TURN_MS);
}
function armMulliganTimer(room) {
  clearMulliganTimer(room);
  const G = room.G, epoch = room.epoch;
  G.deadline = Date.now() + MULLIGAN_MS;
  room.mulliganTimer = setTimeout(() => {
    if (room.epoch !== epoch || !room.G || room.G.phase !== "mulligan") return;
    ["A","B"].forEach(seatX => {
      const seat = room.seats[seatX];
      if (!room.G.S[seatX].mulliganDone && seat && !seat.isCpu) applyMulligan(room, seatX, []);
    });
  }, MULLIGAN_MS);
}

/* ==================== CPU（ソロモード） ==================== */
function cpuPick(G) {
  const S = G.S.B, E = G.S.A;
  const cands = S.hand.map((c,i) => ({c,i}))
    .filter(x => x.c.c <= S.w)
    .filter(x => x.c.t==="s" || S.board.length < BOARD_MAX)
    .filter(x => !(x.c.tg && !E.board.length))
    .filter(x => !(x.c.fx==="heal3" && S.hp >= 17))
    .filter(x => !(x.c.fx==="aoe3" && E.board.length < 2))
    .sort((a,b) => b.c.c - a.c.c);
  if (!cands.length) return null;
  const pick = cands[0];
  let ti;
  if (pick.c.tg) { ti = 0; E.board.forEach((u,j) => { if (u.a > E.board[ti].a) ti = j; }); }
  return { i: pick.i, ti };
}
function scheduleCpuTurn(room) {
  const epoch = room.epoch;
  let guard = 0, aguard = 0;
  function playStep() {
    if (room.epoch!==epoch || !room.G || room.G.result || room.G.active!=="B") { room.cpuBusy=false; return; }
    if (guard++ >= 20) return afterPlay();
    const p = cpuPick(room.G);
    if (!p) return afterPlay();
    applyAction(room, "B", { a:"play", hand:p.i, ti:p.ti });
    setTimeout(playStep, 700);
  }
  function afterPlay() {
    if (room.epoch!==epoch || !room.G || room.G.result) { room.cpuBusy=false; return; }
    const S = room.G.S.B;
    if (S.tn >= EVO.B.turn && S.ep > 0 && S.board.length) {
      const cand = S.board.map((u,j)=>({u,j})).filter(o=>!o.u.evolved).sort((a,b)=>(b.u.a+b.u.hp)-(a.u.a+a.u.hp))[0];
      if (cand) { applyAction(room, "B", { a:"evolve", i:cand.j }); setTimeout(attackStep, 700); return; }
    }
    attackStep();
  }
  function attackStep() {
    if (room.epoch!==epoch || !room.G || room.G.result || room.G.active!=="B") { room.cpuBusy=false; return; }
    if (aguard++ >= 20) return finish();
    const S = room.G.S.B, E = room.G.S.A;
    const ai = S.board.findIndex(u => u.canAtk);
    if (ai < 0) return finish();
    const u = S.board[ai];
    const guards = E.board.map((x,j)=>({x,j})).filter(o=>o.x.kw==="守護");
    let act = null;
    if (guards.length) act = { a:"attack", i:ai, ti:guards[0].j };
    else {
      const tr = E.board.findIndex(x => x.hp<=u.a && x.a<u.hp && x.a>=3);
      if (tr>=0 && Math.random()<.6) act = { a:"attack", i:ai, ti:tr };
      else if (!u.rushOnly) act = { a:"attack", i:ai, target:"leader" };
      else if (E.board.length) act = { a:"attack", i:ai, ti:0 };
      else { u.canAtk=false; setTimeout(attackStep, 10); return; }
    }
    applyAction(room, "B", act);
    setTimeout(attackStep, 700);
  }
  function finish() {
    if (room.epoch===epoch && room.G && !room.G.result) applyAction(room, "B", { a:"end" });
    room.cpuBusy = false;
  }
  setTimeout(playStep, 900);
}

/* ==================== 再戦 ==================== */
function requestRematch(room, seatX) {
  if (!room.G || room.G.phase !== "over") return;
  room.rematch = room.rematch || { A:false, B:false };
  room.rematch[seatX] = true;
  if (room.cpu) room.rematch.B = true;
  const seat = room.seats[seatX];
  send(seat && seat.ws, { type:"rematchWait" });
  const oppSeat = room.seats[other(seatX)];
  if (oppSeat && oppSeat.ws) send(oppSeat.ws, { type:"rematchRequested" });
  if (room.rematch.A && room.rematch.B) {
    newGame(room, room.seats.A.name, room.seats.B.name);
  }
}

/* ==================== WebSocket ハンドリング ==================== */
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "create") {
      const code = genCode();
      const room = makeRoom(code, false);
      const token = genToken();
      room.seats.A = { ws, name: cleanName(m.name) || "先攻⚡", token, connected:true, deck: resolveDeck(m.deck) };
      rooms.set(code, room);
      ws.roomCode = code; ws.seat = "A";
      send(ws, { type:"created", code, token });
    }

    else if (m.type === "join") {
      const room = rooms.get(String(m.code||"").trim());
      if (!room) { send(ws, { type:"error", msg:"ルームが見つかりません" }); return; }
      if (room.seats.B) { send(ws, { type:"error", msg:"このルームは満室です" }); return; }
      const token = genToken();
      room.seats.B = { ws, name: cleanName(m.name) || "後攻🔧", token, connected:true, deck: resolveDeck(m.deck) };
      ws.roomCode = room.code; ws.seat = "B";
      send(ws, { type:"joined", code: room.code, token });
      send(room.seats.A.ws, { type:"guestJoined", name: room.seats.B.name });
      newGame(room, room.seats.A.name, room.seats.B.name);
    }

    else if (m.type === "solo") {
      const code = genCode();
      const room = makeRoom(code, true);
      const token = genToken();
      room.seats.A = { ws, name: cleanName(m.name) || "でんこう⚡", token, connected:true, deck: resolveDeck(m.deck) };
      room.seats.B = { ws:null, name:"CPU🤖", token:null, connected:true, isCpu:true, deck: randomValidDeck() };
      rooms.set(code, room);
      ws.roomCode = code; ws.seat = "A";
      send(ws, { type:"created", code, token, solo:true });
      newGame(room, room.seats.A.name, room.seats.B.name);
    }

    else if (m.type === "resume") {
      const room = rooms.get(String(m.code||"").trim());
      if (!room) { send(ws, { type:"resumeFail" }); return; }
      const seatX = room.seats.A && room.seats.A.token === m.token ? "A"
                  : room.seats.B && room.seats.B.token === m.token ? "B" : null;
      if (!seatX) { send(ws, { type:"resumeFail" }); return; }
      const seat = room.seats[seatX];
      // 同じセッションからの古い接続がまだ生きていれば閉じる（二重接続による操作の競合を防ぐ）
      if (seat.ws && seat.ws !== ws && seat.ws.readyState === WebSocket.OPEN) seat.ws.close();
      seat.ws = ws; seat.connected = true;
      ws.roomCode = room.code; ws.seat = seatX;
      if (room.disconnectTimers[seatX]) { clearTimeout(room.disconnectTimers[seatX]); room.disconnectTimers[seatX] = null; }
      send(ws, { type:"resumed", code: room.code, waiting: !room.G });
      const oppSeat = room.seats[other(seatX)];
      if (oppSeat && oppSeat.ws) send(oppSeat.ws, { type:"opponentReconnected" });
      if (room.G) send(ws, { type:"state", snap: buildSnap(room, seatX) });
    }

    else if (m.type === "action") {
      const room = rooms.get(ws.roomCode); if (!room || !room.G) return;
      const seatX = ws.seat; if (!seatX) return;
      const act = m.act || {};
      if (act.a === "retire") applyRetire(room, seatX);
      else if (room.G.phase === "mulligan" && act.a === "mulligan") applyMulligan(room, seatX, act.idx);
      else if (room.G.phase === "battle") applyAction(room, seatX, act);
    }

    else if (m.type === "rematch") {
      const room = rooms.get(ws.roomCode); if (!room) return;
      if (ws.seat) requestRematch(room, ws.seat);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    const seatX = ws.seat; if (!seatX) return;
    const seat = room.seats[seatX]; if (!seat || seat.ws !== ws) return;
    seat.connected = false; seat.ws = null;
    const oppSeat = room.seats[other(seatX)];
    if (oppSeat && oppSeat.ws) send(oppSeat.ws, { type:"opponentDisconnected" });
    if (room.disconnectTimers[seatX]) clearTimeout(room.disconnectTimers[seatX]);
    room.disconnectTimers[seatX] = setTimeout(() => {
      const r = rooms.get(room.code); if (!r) return;
      const s = r.seats[seatX]; if (!s || s.connected) return;
      const opp = r.seats[other(seatX)];
      if (opp && opp.ws) send(opp.ws, { type:"opponentLeft" });
      clearTurnTimer(r); clearMulliganTimer(r); clearOverTimer(r);
      rooms.delete(r.code);
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log("⚡ ワットでドカン！対戦サーバー起動（サーバー権威型）");
  console.log("   http://localhost:" + PORT + " でアクセス");
});
