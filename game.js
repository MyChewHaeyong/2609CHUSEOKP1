// 팔도마블 게임 로직 (순수 함수 모음) - server.js의 applyAction에서 사용
"use strict";

const START_CASH = 300000;
const GO_BONUS = 30000;
const TOLL_DOUBLE_MS = 90 * 60 * 1000; // 90분

const TOLL_MULT = { cc: 1.0, jl: 1.1, gs: 1.15, sd: 1.2, jj: 1.2 };

const TILES = [
  { pos: 0, name: "귀성길 출발", type: "start" },
  { pos: 1, name: "대전", type: "city", region: "cc", price: 30000 },
  { pos: 2, name: "세종", type: "city", region: "cc", price: 35000 },
  { pos: 3, name: "전통시장", type: "event", eventType: "market" },
  { pos: 4, name: "청주", type: "city", region: "cc", price: 40000 },
  { pos: 5, name: "친척집", type: "event", eventType: "relative" },
  { pos: 6, name: "광주", type: "city", region: "jl", price: 45000 },
  { pos: 7, name: "전주", type: "city", region: "jl", price: 50000 },
  { pos: 8, name: "고속도로 정체", type: "event", eventType: "traffic" },
  { pos: 9, name: "목포", type: "city", region: "jl", price: 58000 },
  { pos: 10, name: "송편가게", type: "event", eventType: "songpyeon" },
  { pos: 11, name: "부산", type: "city", region: "gs", price: 65000 },
  { pos: 12, name: "대구", type: "city", region: "gs", price: 72000 },
  { pos: 13, name: "달토끼 상점", type: "event", eventType: "shop" },
  { pos: 14, name: "울산", type: "city", region: "gs", price: 85000 },
  { pos: 15, name: "복불복 윷판", type: "event", eventType: "yut" },
  { pos: 16, name: "제주", type: "city", region: "jj", price: 150000 },
  { pos: 17, name: "인천", type: "city", region: "sd", price: 95000 },
  { pos: 18, name: "친척집", type: "event", eventType: "relative" },
  { pos: 19, name: "수원", type: "city", region: "sd", price: 105000 },
  { pos: 20, name: "서울", type: "city", region: "sd", price: 130000 },
];

const MISSIONS = ["애교 대사 한마디 하기", "좋아하는 노래 한 소절 부르기(10초)", "사투리로 인사말 하기"];

function cityTilesOfRegion(region) {
  return TILES.filter((t) => t.type === "city" && t.region === region);
}
function ownsRegion(state, playerId, region) {
  if (!playerId) return false;
  return cityTilesOfRegion(region).every((t) => state.properties[t.pos]?.ownerId === playerId);
}
function assertCurrentTurn(state, playerId) {
  if (state.phase !== "playing") throw new Error("게임이 진행 중이 아닙니다.");
  if (state.currentPlayerId !== playerId) throw new Error("지금은 당신의 차례가 아닙니다.");
}

// ---------------------------------------------------------------------------
function initState(players) {
  const st = {
    phase: "playing",
    turnOrder: players.map((p) => p.id),
    currentIdx: 0,
    currentPlayerId: players[0].id,
    turnPhase: "awaiting-roll",
    gameStartedAt: null,
    pendingEvent: null,
    lastRoll: null,
    winnerId: null,
    log: ["게임을 시작합니다."],
    players: {},
    properties: {},
  };
  players.forEach((p) => {
    st.players[p.id] = {
      name: p.name,
      isBot: !!p.isBot,
      seat: p.seat,
      cash: START_CASH,
      position: 0,
      bankrupt: false,
      songpyeon: 0,
      items: [],
      nextRollPenalty: false,
    };
  });
  return st;
}

function tollFor(state, pos, now) {
  const tile = TILES[pos];
  const prop = state.properties[pos] || { ownerId: null, building: "none" };
  const mult = TOLL_MULT[tile.region];
  let tier;
  if (prop.building === "hotel") tier = 0.6;
  else if (prop.building === "villa") tier = 0.3;
  else if (cityTilesOfRegion(tile.region).length > 1 && ownsRegion(state, prop.ownerId, tile.region)) tier = 0.2;
  else tier = 0.1;
  let amount = Math.round(tile.price * tier * mult);
  if (state.gameStartedAt && now - state.gameStartedAt > TOLL_DOUBLE_MS) amount *= 2;
  return amount;
}

function stepSellValue(tile, fromLevel) {
  if (fromLevel === "hotel") return Math.round(tile.price * 0.25);
  if (fromLevel === "villa") return Math.round(tile.price * 0.25);
  return Math.round(tile.price * 0.5); // 땅 자체 매각
}
function sellOneStep(state, pos) {
  const tile = TILES[pos];
  const prop = state.properties[pos];
  if (!prop || !prop.ownerId) return 0;
  if (prop.building === "hotel") {
    prop.building = "villa";
    return stepSellValue(tile, "hotel");
  }
  if (prop.building === "villa") {
    prop.building = "none";
    return stepSellValue(tile, "villa");
  }
  const refund = stepSellValue(tile, "none");
  delete state.properties[pos];
  return refund;
}

// 반환값: 실제로 걷은 금액(파산으로 일부만 걷혔을 수 있음). 호출한 쪽에서
// 상대에게 얼마를 지급할지, 그리고 이 플레이어가 파산했는지(state.players[playerId].bankrupt)를
// 반드시 확인해서 그에 맞게 턴을 처리해야 합니다(파산 시 자동으로 턴이 넘어가지 않으므로).
function chargePlayer(state, playerId, amount, now) {
  if (amount <= 0) return 0;
  const p = state.players[playerId];
  if (p.cash >= amount) {
    p.cash -= amount;
    return amount;
  }
  let paid = p.cash;
  let need = amount - p.cash;
  p.cash = 0;
  let progress = true;
  while (need > 0 && progress) {
    progress = false;
    const myPositions = Object.keys(state.properties)
      .map(Number)
      .filter((pos) => state.properties[pos].ownerId === playerId);
    for (const pos of myPositions) {
      if (need <= 0) break;
      const refund = sellOneStep(state, pos);
      if (refund > 0) {
        const useForDebt = Math.min(refund, need);
        paid += useForDebt;
        need -= useForDebt;
        p.cash += refund - useForDebt;
        progress = true;
      }
    }
  }
  if (need > 0) {
    p.cash = 0;
    bankruptPlayer(state, playerId);
  }
  return paid;
}

// 자산 평가액(결산용): 땅은 구매가, 별장은 +구매가 50%, 호텔은 +구매가 100%(별장분 포함)로 계산.
// 매각가(청산 시 50%씩 돌려받는 값)와는 다른, "규칙서 결산 코드" 절에서 말하는 순위용 평가액입니다.
function assetValue(state, playerId) {
  let total = 0;
  Object.keys(state.properties).forEach((posStr) => {
    const pos = Number(posStr);
    const prop = state.properties[pos];
    if (prop.ownerId !== playerId) return;
    const tile = TILES[pos];
    total += tile.price;
    if (prop.building === "villa") total += Math.round(tile.price * 0.5);
    else if (prop.building === "hotel") total += Math.round(tile.price * 0.5) * 2;
  });
  return total;
}
function netWorth(state, playerId) {
  return state.players[playerId].cash + assetValue(state, playerId);
}

// 최종 순위 계산: 생존자는 자산 평가액(현금+토지+건물) 내림차순, 파산자는 "나중에 파산할수록" 더 오래
// 버틴 것이므로 그 뒤에 파산 역순으로 이어붙입니다. (규칙서 "결산 코드" 절 기준)
function computeFinalRanking(state) {
  const bankruptOrder = state.bankruptOrder || [];
  const alive = state.turnOrder.filter((id) => !state.players[id].bankrupt);
  const bankrupt = state.turnOrder.filter((id) => state.players[id].bankrupt);

  const aliveRanked = alive
    .map((id) => ({
      playerId: id,
      name: state.players[id].name,
      cash: state.players[id].cash,
      assetValue: assetValue(state, id),
      netWorth: netWorth(state, id),
      songpyeon: state.players[id].songpyeon,
      bankrupt: false,
    }))
    .sort((a, b) => b.netWorth - a.netWorth);

  const bankruptRanked = bankrupt
    .slice()
    .sort((a, b) => bankruptOrder.indexOf(b) - bankruptOrder.indexOf(a)) // 나중에 파산 = 더 높은 순위
    .map((id) => ({
      playerId: id,
      name: state.players[id].name,
      cash: 0,
      assetValue: 0,
      netWorth: 0,
      songpyeon: state.players[id].songpyeon,
      bankrupt: true,
    }));

  return [...aliveRanked, ...bankruptRanked].map((r, i) => ({ ...r, rank: i + 1 }));
}

function bankruptPlayer(state, playerId) {
  const p = state.players[playerId];
  if (p.bankrupt) return;
  p.bankrupt = true;
  p.cash = 0;
  Object.keys(state.properties).forEach((pos) => {
    if (state.properties[pos].ownerId === playerId) delete state.properties[pos];
  });
  if (!state.bankruptOrder) state.bankruptOrder = [];
  state.bankruptOrder.push(playerId);
  state.log.push(`${p.name} 파산했습니다.`);
  const alive = state.turnOrder.filter((id) => !state.players[id].bankrupt);
  if (alive.length <= 1) {
    state.phase = "ended";
    state.winnerId = alive[0] || null;
    state.turnPhase = "ended";
    state.finalRanking = computeFinalRanking(state);
    state.log.push(alive[0] ? `게임 종료! 승자: ${state.players[alive[0]].name}` : "게임 종료!");
    return;
  }
  // 사람 참가자가 전원 파산해서 BOT끼리만 남으면, 더 진행해도 사람이 볼 게 없으므로
  // 그 순간 자산 기준으로 자동 정산하고 게임을 끝냅니다. (사람이 없으면 서버에 다음 행동을
  // 보내줄 사람도 없어서, 이렇게 하지 않으면 방이 영원히 "진행 중" 상태로 멈춰버립니다)
  const humansAlive = alive.some((id) => !state.players[id].isBot);
  if (!humansAlive) {
    state.phase = "ended";
    state.turnPhase = "ended";
    state.finalRanking = computeFinalRanking(state);
    state.winnerId = state.finalRanking[0] ? state.finalRanking[0].playerId : null;
    state.log.push("남은 참가자가 모두 BOT이라 자동으로 종료하고 자산 기준으로 순위를 정산했습니다.");
  }
}

// 관리자용 비상 강제 종료: 방송 시간 등의 이유로 "최후 1인 생존"을 기다릴 수 없을 때,
// 지금 이 순간의 자산(현금+토지+건물 평가액) 기준으로 순위를 확정하고 게임을 끝냅니다.
function forceEndGame(state) {
  if (state.phase !== "playing") throw new Error("지금은 게임을 종료할 수 없습니다(진행 중이 아님).");
  state.phase = "ended";
  state.turnPhase = "ended";
  state.pendingEvent = null;
  const ranking = computeFinalRanking(state);
  state.finalRanking = ranking;
  state.winnerId = ranking[0] ? ranking[0].playerId : null;
  state.log.push("관리자가 게임을 강제 종료하고, 현재 자산 기준으로 순위를 정산했습니다.");
  return state;
}

function advanceTurn(state) {
  if (state.phase === "ended") return;
  const n = state.turnOrder.length;
  let idx = state.currentIdx;
  for (let i = 0; i < n; i++) {
    idx = (idx + 1) % n;
    const pid = state.turnOrder[idx];
    if (!state.players[pid].bankrupt) {
      state.currentIdx = idx;
      state.currentPlayerId = pid;
      state.turnPhase = "awaiting-roll";
      state.pendingEvent = null;
      return;
    }
  }
}

function generateMarketCards() {
  const mag = () => (5 + Math.floor(Math.random() * 11)) * 1000; // 5000~15000
  const signs = [1, -1, Math.random() < 0.5 ? 1 : -1];
  for (let i = signs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [signs[i], signs[j]] = [signs[j], signs[i]];
  }
  return signs.map((s) => s * mag());
}
function rollYut() {
  const r = Math.random();
  if (r < 0.4) return 5000;
  if (r < 0.65) return 10000;
  if (r < 0.85) return -10000;
  if (r < 0.95) return 25000;
  return -25000;
}

function startEvent(state, playerId, tile, now) {
  const p = state.players[playerId];
  if (tile.eventType === "market") {
    state.pendingEvent = { type: "market", cards: generateMarketCards() };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "relative") {
    state.pendingEvent = { type: "relative", mission: MISSIONS[Math.floor(Math.random() * MISSIONS.length)] };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "shop") {
    state.pendingEvent = { type: "shop" };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "traffic") {
    p.nextRollPenalty = true;
    state.log.push(`${p.name}: 고속도로 정체 (다음 이동 -1)`);
    state.turnPhase = "awaiting-endturn";
  } else if (tile.eventType === "songpyeon") {
    const n = 1 + Math.floor(Math.random() * 3);
    p.songpyeon += n;
    state.log.push(`${p.name}: 송편 토큰 +${n} (누적 ${p.songpyeon})`);
    state.turnPhase = "awaiting-endturn";
  } else if (tile.eventType === "yut") {
    const delta = rollYut();
    if (delta >= 0) p.cash += delta;
    else chargePlayer(state, playerId, -delta, now);
    state.log.push(`${p.name}: 복불복 윷판 ${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`);
    state.turnPhase = "awaiting-endturn";
  }
}

function applyEventChoice(state, playerId, choice, now) {
  const p = state.players[playerId];
  const ev = state.pendingEvent;
  if (!ev) throw new Error("지금은 처리할 이벤트가 없습니다.");
  if (ev.type === "market") {
    const idx = [0, 1, 2].includes(choice) ? choice : Math.floor(Math.random() * 3);
    const delta = ev.cards[idx];
    if (delta >= 0) p.cash += delta;
    else chargePlayer(state, playerId, -delta, now);
    state.log.push(`${p.name}: 전통시장 카드 결과 ${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`);
  } else if (ev.type === "relative") {
    if (choice === "perform") {
      const bonus = 5000 + Math.floor(Math.random() * 6) * 1000;
      p.cash += bonus;
      state.log.push(`${p.name}: 친척집 미션 수행 +${bonus.toLocaleString()}`);
    } else {
      state.log.push(`${p.name}: 친척집 미션 패스`);
    }
  } else if (ev.type === "shop") {
    const item = ["toll-free", "reroll", "half-build"].includes(choice) ? choice : null;
    if (item && p.cash >= 15000) {
      p.cash -= 15000;
      p.items.push(item);
      state.log.push(`${p.name}: 달토끼 상점에서 ${itemLabel(item)} 구매`);
    } else {
      state.log.push(`${p.name}: 달토끼 상점 패스`);
    }
  }
  state.pendingEvent = null;
}
function itemLabel(item) {
  return { "toll-free": "통행료 면제권", reroll: "주사위 재굴림권", "half-build": "건설비 반값권" }[item] || item;
}

function applyRoll(state, playerId, now) {
  if (!state.gameStartedAt) state.gameStartedAt = now;
  const p = state.players[playerId];
  const roll = 1 + Math.floor(Math.random() * 6);
  let steps = roll;
  let stayed = false;
  if (p.nextRollPenalty) {
    p.nextRollPenalty = false;
    if (roll === 1) {
      steps = 0;
      stayed = true;
    } else {
      steps = roll - 1;
    }
  }
  const prevPos = p.position;
  const newPos = (prevPos + steps) % TILES.length;
  const passedGo = steps > 0 && prevPos + steps >= TILES.length;
  p.position = newPos;
  state.lastRoll = { roll, steps, stayed, from: prevPos, to: newPos };
  state.log.push(`${p.name}: 주사위 ${roll}${stayed ? " (정체로 이동 없음)" : ""}`);
  if (stayed) {
    state.turnPhase = "awaiting-endturn";
    return;
  }
  if (passedGo || newPos === 0) {
    p.cash += GO_BONUS;
    state.log.push(`${p.name}: 귀성길 출발 통과, 용돈 +${GO_BONUS.toLocaleString()}`);
  }
  const tile = TILES[newPos];
  if (tile.type === "start") {
    state.turnPhase = "awaiting-endturn";
    return;
  }
  if (tile.type === "city") {
    const prop = state.properties[tile.pos];
    if (!prop || !prop.ownerId) {
      state.turnPhase = "awaiting-buy";
      return;
    }
    if (prop.ownerId === playerId) {
      state.turnPhase = "awaiting-endturn";
      return;
    }
    let amount = tollFor(state, tile.pos, now);
    const tfIdx = p.items.indexOf("toll-free");
    if (tfIdx !== -1 && amount > 0) {
      p.items.splice(tfIdx, 1);
      state.log.push(`${p.name}: 통행료 면제권 사용`);
      amount = 0;
    }
    if (amount > 0) {
      const paid = chargePlayer(state, playerId, amount, now);
      const owner = state.players[prop.ownerId];
      if (owner && paid > 0) owner.cash += paid;
      state.log.push(
        `${p.name} → ${owner ? owner.name : "?"} 통행료 ${paid.toLocaleString()}` +
          (paid < amount ? " (자금 부족으로 파산)" : "")
      );
    }
    // 통행료를 내다가 파산했다면 턴을 마무리할 사람이 없으므로 곧바로 다음 사람에게 넘김
    if (p.bankrupt) {
      advanceTurn(state);
      return;
    }
    state.turnPhase = "awaiting-endturn";
    return;
  }
  // event tile
  startEvent(state, playerId, tile, now);
  // 복불복 윷판에서 돈을 잃다가 파산했을 수도 있으므로 여기서도 동일하게 확인
  if (p.bankrupt) {
    advanceTurn(state);
  }
}

function wouldCompleteRegion(state, playerId, tile) {
  const others = cityTilesOfRegion(tile.region).filter((t) => t.pos !== tile.pos);
  return others.every((t) => state.properties[t.pos]?.ownerId === playerId);
}

function maybeBotBuild(state, playerId) {
  const p = state.players[playerId];
  for (const pos of Object.keys(state.properties).map(Number)) {
    const prop = state.properties[pos];
    if (prop.ownerId !== playerId) continue;
    const tile = TILES[pos];
    if (!ownsRegion(state, playerId, tile.region)) continue;
    if (prop.building === "none" && p.cash - Math.round(tile.price * 0.5) >= 20000) {
      p.cash -= Math.round(tile.price * 0.5);
      prop.building = "villa";
      state.log.push(`${p.name}(BOT): ${tile.name}에 별장 건설`);
    } else if (prop.building === "villa" && p.cash - Math.round(tile.price * 0.5) >= 20000) {
      p.cash -= Math.round(tile.price * 0.5);
      prop.building = "hotel";
      state.log.push(`${p.name}(BOT): ${tile.name}에 호텔 건설`);
    }
  }
}

function botResolveEvent(state, playerId, now) {
  const ev = state.pendingEvent;
  if (!ev) return;
  let choice;
  if (ev.type === "market") choice = Math.floor(Math.random() * 3);
  else if (ev.type === "relative") choice = Math.random() < 0.7 ? "perform" : "pass";
  else if (ev.type === "shop") {
    const p = state.players[playerId];
    choice = p.cash >= 60000 ? ["toll-free", "reroll", "half-build"][Math.floor(Math.random() * 3)] : "pass";
  }
  applyEventChoice(state, playerId, choice, now);
}

function botTakeTurn(state, now) {
  const pid = state.currentPlayerId;
  applyRoll(state, pid, now);
  const p = state.players[pid];
  // 통행료/윷판에서 파산했다면 applyRoll이 이미 턴을 다음 사람에게 넘긴 상태이므로 더 손댈 게 없음
  if (p.bankrupt) return;
  if (state.turnPhase === "awaiting-buy") {
    const tile = TILES[p.position];
    const afford = p.cash - tile.price;
    if (tile.price <= p.cash && (afford >= 20000 || wouldCompleteRegion(state, pid, tile))) {
      state.properties[tile.pos] = { ownerId: pid, building: "none" };
      p.cash -= tile.price;
      state.log.push(`${p.name}(BOT): ${tile.name} 구매`);
    }
    state.turnPhase = "awaiting-endturn";
  } else if (state.turnPhase === "awaiting-event") {
    botResolveEvent(state, pid, now);
    if (p.bankrupt) {
      advanceTurn(state);
      return;
    }
    state.turnPhase = "awaiting-endturn";
  }
  maybeBotBuild(state, pid);
  advanceTurn(state);
}

function runBotsIfNeeded(state, now) {
  let guard = 0;
  while (state.phase === "playing" && state.players[state.currentPlayerId]?.isBot && guard < 60) {
    guard++;
    botTakeTurn(state, now);
  }
}

// ---------------------------------------------------------------------------
function applyPlayerAction(state, playerId, type, payload, now) {
  if (state.phase !== "playing") throw new Error("게임이 진행 중이 아닙니다.");
  const p = state.players[playerId];
  if (!p) throw new Error("이 게임의 참가자가 아닙니다.");
  if (p.bankrupt) throw new Error("이미 파산해서 더 이상 행동할 수 없습니다.");

  switch (type) {
    case "roll-dice": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-roll") throw new Error("지금은 주사위를 굴릴 수 없습니다.");
      applyRoll(state, playerId, now);
      break;
    }
    case "buy-property": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-buy") throw new Error("지금은 구매할 수 없습니다.");
      const tile = TILES[p.position];
      if (p.cash < tile.price) throw new Error("자금이 부족합니다.");
      p.cash -= tile.price;
      state.properties[tile.pos] = { ownerId: playerId, building: "none" };
      state.log.push(`${p.name}: ${tile.name} 구매`);
      state.turnPhase = "awaiting-endturn";
      break;
    }
    case "skip-buy": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-buy") throw new Error("지금은 구매를 넘길 수 없습니다.");
      state.turnPhase = "awaiting-endturn";
      break;
    }
    case "resolve-event": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-event" || !state.pendingEvent) throw new Error("지금은 처리할 이벤트가 없습니다.");
      applyEventChoice(state, playerId, payload?.choice, now);
      // 전통시장 카드에서 큰 손해를 봐서 파산했을 수도 있음 → 그 경우 곧바로 다음 사람 턴으로
      if (p.bankrupt) {
        advanceTurn(state);
        break;
      }
      state.turnPhase = "awaiting-endturn";
      break;
    }
    case "build": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("지금은 건설할 수 없습니다.");
      const pos = payload?.tilePos;
      const tile = TILES[pos];
      if (!tile || tile.type !== "city") throw new Error("건설할 수 없는 칸입니다.");
      const prop = state.properties[pos];
      if (!prop || prop.ownerId !== playerId) throw new Error("본인 소유의 땅이 아닙니다.");
      if (!ownsRegion(state, playerId, tile.region)) throw new Error("같은 권역을 모두 소유해야 건설할 수 있습니다.");
      let cost;
      if (payload.level === "villa") {
        if (prop.building !== "none") throw new Error("이미 건물이 있습니다.");
        cost = Math.round(tile.price * 0.5);
      } else if (payload.level === "hotel") {
        if (prop.building !== "villa") throw new Error("먼저 별장을 지어야 합니다.");
        cost = Math.round(tile.price * 0.5);
      } else {
        throw new Error("알 수 없는 건물 종류입니다.");
      }
      const halfIdx = p.items.indexOf("half-build");
      if (halfIdx !== -1) {
        cost = Math.round(cost * 0.5);
        p.items.splice(halfIdx, 1);
        state.log.push(`${p.name}: 건설비 반값권 사용`);
      }
      if (p.cash < cost) throw new Error("자금이 부족합니다.");
      p.cash -= cost;
      prop.building = payload.level;
      state.log.push(`${p.name}: ${tile.name}에 ${payload.level === "villa" ? "별장" : "호텔"} 건설`);
      break;
    }
    case "sell-property": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("지금은 매각할 수 없습니다.");
      const pos = payload?.tilePos;
      const prop = state.properties[pos];
      if (!prop || prop.ownerId !== playerId) throw new Error("본인 소유의 땅이 아닙니다.");
      const refund = sellOneStep(state, pos);
      p.cash += refund;
      state.log.push(`${p.name}: 매각 +${refund.toLocaleString()}`);
      break;
    }
    case "use-item": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("지금은 아이템을 쓸 수 없습니다.");
      if (payload?.item !== "reroll") throw new Error("지금 쓸 수 있는 아이템이 아닙니다.");
      const idx = p.items.indexOf("reroll");
      if (idx === -1) throw new Error("보유한 재굴림권이 없습니다.");
      p.items.splice(idx, 1);
      state.log.push(`${p.name}: 주사위 재굴림권 사용`);
      state.turnPhase = "awaiting-roll";
      applyRoll(state, playerId, now);
      break;
    }
    case "end-turn": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("아직 처리할 일이 남아있습니다.");
      advanceTurn(state);
      break;
    }
    default:
      throw new Error("알 수 없는 행동입니다: " + type);
  }
  runBotsIfNeeded(state, now);
  return state;
}

module.exports = {
  TILES,
  TOLL_MULT,
  START_CASH,
  GO_BONUS,
  initState,
  applyPlayerAction,
  runBotsIfNeeded,
  tollFor,
  ownsRegion,
  forceEndGame,
  computeFinalRanking,
  netWorth,
  assetValue,
};
