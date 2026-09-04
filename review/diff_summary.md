# 抜粋diff

主要変更をレビューしやすいよう、代表的な変更前／変更後だけを対で示す。完全な変更後コードは `review/server.js` と `review/public_index.html` を参照。

## 1. ルームのモード保持

変更前:

```js
function makeRoom(code, cpu) {
  return { code, cpu: !!cpu, seats: { A:null, B:null }, G:null };
}
```

変更後:

```js
function normMode(mode) { return mode === "enjoy" ? "enjoy" : "gachi"; }

function makeRoom(code, cpu, mode) {
  return {
    code, cpu: !!cpu, mode: normMode(mode),
    seats: { A:null, B:null }, G:null,
    // 既存フィールド...
  };
}
```

## 2. HP境界の検出と非常用電源

変更前:

```js
// HP 10以下への進入を追跡する状態・共通処理なし
```

変更後:

```js
function checkEmergency(room, rng) {
  const G = room.G;
  G.emergencyLow = G.emergencyLow || { A:false, B:false };
  const activated = [];
  ["A", "B"].forEach(seatX => {
    const s = G.S[seatX];
    if (s.hp > 10) { G.emergencyLow[seatX] = false; return; }
    if (G.emergencyLow[seatX]) return;
    G.emergencyLow[seatX] = true;
    if (room.mode !== "enjoy") return;

    if ((rng || Math.random)() < 0.5) {
      s.w = Math.min(s.maxW, s.w + 300);
    } else {
      drawN(G, seatX, 1);
    }
    activated.push({ seat:seatX, name:G.names[seatX], effect, effectName });
  });
  return activated;
}
```

## 3. 既存イベント経路への統合

変更前:

```js
const lastwords = processDeaths(room);
const { diffs, deaths } = diffHP(before, G);
pushEvent(G, { type:evType, diffs, deaths, lastwords, ...evMeta });
```

変更後:

```js
const lastwords = processDeaths(room);
const emergencies = checkEmergency(room);
const { diffs, deaths } = diffHP(before, G);
pushEvent(G, { type:evType, diffs, deaths, lastwords, emergencies, ...evMeta });
```

## 4. 戦績とランキング集計の分離

変更前:

```js
rec.games++;
if (win) rec.win++; else rec.loss++;
```

変更後:

```js
rec.games++;
if (win) rec.win++; else rec.loss++;
if (ranked) {
  rec.rankedGames++;
  if (win) rec.rankedWin++; else rec.rankedLoss++;
}
```

`computeTop` は `ranked*` を使用し、`recordMatchResult` は `room.mode === "gachi"` の場合だけ `ranked` を真にする。

## 5. ロビーのモード選択

変更前:

```html
<button id="btnCreate">⚡ ルームを作る（先攻）</button>
```

変更後:

```html
<div class="modepick">
  <button class="ghost" id="btnModeEnjoy">🎮 エンジョイモード</button>
  <button class="ghost active-mode" id="btnModeGachi">⚔ ガチモード</button>
</div>
<button id="btnCreate">⚡ ルームを作る（先攻）</button>
```

```js
connectAndSend({ type:"create", name:myName, deck:getActiveDeckIds(), playerId, mode:selectedMode });
connectAndSend({ type:"solo", name:myName, difficulty, deck:getActiveDeckIds(), playerId, mode:selectedMode });
```

参加時の `join` にはモードを含めず、サーバー上の `room.mode` をそのまま使用する。

## 6. 発動カットイン

変更前:

```js
// 非常用電源専用の全画面演出・効果音なし
```

変更後:

```js
function playEmergencyCutin(info) {
  return new Promise(resolve => {
    // 残っているポップを除去し、独立した暗幕で操作を遮断する。
    document.querySelectorAll(".dmgpop,.iconpop").forEach(el => el.remove());
    emergencyCutin.classList.add("show");
    Snd.emergency();
    setTimeout(() => {
      emergencyCutin.classList.remove("show");
      resolve();
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 1500 : 1750);
  });
}

async function playEvent(ev, prevSnap) {
  for (const info of (ev.emergencies || [])) await playEmergencyCutin(info);
  // 完了後に攻撃・ダメージ・ラストワード演出を開始する。
}
```

CSSは暗転0.15秒、稲妻の0.2秒スライド、遅延した見出し拡大、終端フェードを定義する。`prefers-reduced-motion: reduce` では稲妻を隠し、テキストフェードだけを残す。
