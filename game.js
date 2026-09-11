// 팔도마블 게임 로직 (순수 함수 모음) - server.js의 applyAction에서 사용
"use strict";
const DonationEffect = require("./donationEffect.js");

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

// 후원 효과 가격 보정 — 참가자(스트리머)별로 완전히 독립된 후원 집계를 가집니다.
// 적용 범위는 통행료 계산 한 곳뿐입니다(구매가·건설비·매각환급금·자산가치에는 영향 없음 —
// 사용자 확정 사항). 통행료를 "내는 사람"(방문자) 본인의 누적 보정률만 적용하고, 주인은
// 방문자가 실제로 낸 금액을 그대로 받습니다(중복 보정 방지). BOT은 채널이 없으므로 항상
// 보정률 0(효과 없음)이고, 방 전체 스위치(donationEnabled)를 끄면 누적 기록은 그대로 둔 채
// 가격에는 반영되지 않습니다.
function donationRate(state, playerId) {
  if (state.donationEnabled === false) return 0;
  const p = state.players && state.players[playerId];
  if (p && p.isBot) return 0;
  const de = state.donationEffects && state.donationEffects[playerId];
  return de ? de.cumulativeRate : 0;
}

// ---------------------------------------------------------------------------
// existingDonationEffects: 게임 시작 전(waiting) 상태에서 관리자가 이미 참가자별 후원을
// 집계해뒀다면(수동 +1 버튼/SOOP 자동감지를 게임 시작 전부터 켜둔 경우) 그 값을 이어받기
// 위한 선택 인자입니다({ [playerId]: donationEffect상태 } 형태). 넘기지 않으면 빈 맵으로 시작.
// existingDonationEnabled: 방 전체 후원 효과 켜짐/꺼짐 스위치(기본 true).
function initState(players, existingDonationEffects, existingDonationEnabled) {
  const st = {
    phase: "playing",
    turnOrder: players.map((p) => p.id),
    currentIdx: 0,
    currentPlayerId: players[0].id,
    turnPhase: "awaiting-roll",
    gameStartedAt: null,
    pendingEvent: null,
    pendingToll: null,
    lastRoll: null,
    winnerId: null,
    log: ["게임을 시작합니다."],
    players: {},
    properties: {},
    donationEffects: existingDonationEffects || {},
    donationEnabled: existingDonationEnabled !== false,
  };
  players.forEach((p) => {
    st.players[p.id] = {
      name: p.name,
      isBot: !!p.isBot,
      seat: p.seat,
      characterId: p.characterId || null,
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
  // 후원 효과는 통행료에만 적용됩니다(사용자 확정 사항: "후원은 통행료만을 기준으로 함").
  // 적용 기준은 "받는 사람(땅 주인)"의 누적 보정률입니다 — 내는 사람(방문자)이 아니라
  // 주인 본인 채널의 후원이 자기 땅의 통행료 "수입"에 영향을 준다는 뜻입니다(긍정 보정률
  // = 주인의 통행료 수입 증가, 부정 보정률 = 감소). 걷힌 금액을 그대로 주인이 받는
  // 구조이므로 여기 한 번만 보정하면 양쪽 모두에 자연스럽게 반영됩니다.
  amount = DonationEffect.applyIncomeRate(amount, donationRate(state, prop.ownerId));
  return amount;
}

// tollFor()와 완전히 동일한 계산이되, 후원 효과 보정만 적용하지 않은 "원래 통행료"입니다.
// 참가자 화면에서 칸을 클릭했을 때 "원가 vs 후원 효과 반영가"를 나란히 보여주기 위한
// 용도로만 씁니다(실제 청구/정산에는 항상 tollFor()만 사용됨).
function tollForPlain(state, pos, now) {
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

function stepSellValue(state, tile, fromLevel) {
  // 매각환급금은 후원 효과 적용 범위에서 제외됩니다(통행료만 적용 — 사용자 확정 사항).
  return fromLevel === "hotel" || fromLevel === "villa" ? Math.round(tile.price * 0.25) : Math.round(tile.price * 0.5);
}
function sellOneStep(state, pos) {
  const tile = TILES[pos];
  const prop = state.properties[pos];
  if (!prop || !prop.ownerId) return 0;
  if (prop.building === "hotel") {
    prop.building = "villa";
    return stepSellValue(state, tile, "hotel");
  }
  if (prop.building === "villa") {
    prop.building = "none";
    return stepSellValue(state, tile, "villa");
  }
  const refund = stepSellValue(state, tile, "none");
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
  // 자산 평가액은 후원 효과 적용 범위에서 제외됩니다(통행료만 적용 — 사용자 확정 사항).
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
      state.pendingToll = null;
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

// 통행료 면제권을 실제로 쓸지 말지 확정 짓고 통행료를 정산합니다. useItem이 true이고
// 실제로 면제권을 들고 있으면 소모하며 통행료 0원, 아니면 정상적으로 통행료를 냅니다.
// 봇은 항상 useItem=true로 이 함수를 호출해(기존 자동 사용 동작 그대로 유지) 곧바로
// 처리하고, 사람은 awaiting-toll 단계에서 직접 선택한 뒤에야 이 함수가 호출됩니다.
function resolveToll(state, playerId, useItem, now) {
  const p = state.players[playerId];
  const pending = state.pendingToll;
  state.pendingToll = null;
  if (!pending) return;
  let amount = pending.amount;
  const tfIdx = p.items.indexOf("toll-free");
  if (useItem && tfIdx !== -1 && amount > 0) {
    p.items.splice(tfIdx, 1);
    state.log.push(`${p.name}: 통행료 면제권 사용`);
    amount = 0;
  }
  if (amount > 0) {
    const paid = chargePlayer(state, playerId, amount, now);
    const owner = state.players[pending.ownerId];
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
    const amount = tollFor(state, tile.pos, now);
    state.pendingToll = { pos: tile.pos, amount, ownerId: prop.ownerId };
    const hasTollFree = p.items.includes("toll-free");
    if (amount > 0 && hasTollFree && !p.isBot) {
      // 사람 플레이어는 면제권을 실제로 쓸지 직접 고를 수 있도록 턴을 잠시 멈춥니다.
      state.turnPhase = "awaiting-toll";
      return;
    }
    // 봇이거나(기존처럼 있으면 자동 사용) 면제권이 없거나 통행료가 0원이면 곧바로 처리
    resolveToll(state, playerId, hasTollFree, now);
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
    const cost = Math.round(tile.price * 0.5); // 건설비는 후원 효과 적용 범위 밖(통행료만 적용)
    if (prop.building === "none" && p.cash - cost >= 20000) {
      p.cash -= cost;
      prop.building = "villa";
      state.log.push(`${p.name}(BOT): ${tile.name}에 별장 건설`);
    } else if (prop.building === "villa" && p.cash - cost >= 20000) {
      p.cash -= cost;
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
    const price = tile.price; // 구매가는 후원 효과 적용 범위 밖(통행료만 적용)
    const afford = p.cash - price;
    if (price <= p.cash && (afford >= 20000 || wouldCompleteRegion(state, pid, tile))) {
      state.properties[tile.pos] = { ownerId: pid, building: "none" };
      p.cash -= price;
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
      const price = tile.price; // 구매가는 후원 효과 적용 범위 밖(통행료만 적용)
      if (p.cash < price) throw new Error("자금이 부족합니다.");
      p.cash -= price;
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
    case "resolve-toll": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-toll" || !state.pendingToll) throw new Error("지금은 처리할 통행료가 없습니다.");
      resolveToll(state, playerId, !!payload?.useItem, now);
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
        cost = Math.round(tile.price * 0.5); // 건설비는 후원 효과 적용 범위 밖(통행료만 적용)
      } else if (payload.level === "hotel") {
        if (prop.building !== "villa") throw new Error("먼저 별장을 지어야 합니다.");
        cost = Math.round(tile.price * 0.5); // 건설비는 후원 효과 적용 범위 밖(통행료만 적용)
      } else {
        throw new Error("알 수 없는 건물 종류입니다.");
      }
      if (payload?.useItem) {
        const halfIdx = p.items.indexOf("half-build");
        if (halfIdx === -1) throw new Error("보유한 건설비 반값권이 없습니다.");
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

// 관리자 수동 "+1" 버튼 / SOOP 자동 감지가 호출하는 진입점. 게임이 아직 시작 전(waiting)
// 이거나 이미 끝난 뒤(ended)라도 후원 카운트 자체는 계속 쌓일 수 있게 phase 체크는 하지
// 않습니다(방송은 게임 진행과 무관하게 계속되므로). playerId로 어느 참가자(스트리머)의
// 채널에 들어온 후원인지 지정합니다 — 참가자별로 완전히 독립된 카운트/누적 보정률을
// 가지므로, 스트리머 B의 후원은 스트리머 B의 donationEffects[playerId]에만 쌓입니다.
// donationEffect.js 자체는 state.donationEffect(단수) 필드를 다루도록 짜여 있으므로,
// 여기서는 해당 플레이어의 상태를 담은 얇은 래퍼 객체를 만들어 넘기고 결과를 다시
// state.donationEffects[playerId]에 저장합니다(모듈 수정 없이 그대로 재사용).
function addDonation(state, playerId, count, now, source) {
  // 게임 시작 전(waiting)에는 state가 { phase: "waiting" }뿐이라 log 배열이 아직 없을 수 있음
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.donationEffects) state.donationEffects = {};
  const wrapper = { donationEffect: state.donationEffects[playerId] || null };
  const fired = DonationEffect.addDonations(wrapper, count, now, source);
  state.donationEffects[playerId] = wrapper.donationEffect;
  const pname = (state.players && state.players[playerId] && state.players[playerId].name) || playerId;
  fired.forEach((f) => {
    state.log.push(
      `[후원 효과] ${pname} 후원 ${f.donationSize}개 — ${f.deltaPct >= 0 ? "+" : ""}${f.deltaPct.toFixed(1)}% (누적 보정률 ${(f.after * 100).toFixed(1)}%)`
    );
  });
  return fired;
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
  tollForPlain,
  ownsRegion,
  forceEndGame,
  computeFinalRanking,
  netWorth,
  assetValue,
  addDonation,
  donationRate,
};
