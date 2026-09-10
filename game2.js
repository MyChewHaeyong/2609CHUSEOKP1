// 만찬경매 - 2부 게임 로직 (블라인드 순차 경쟁입찰 + 시청자 링크투표)
// 1부(game.js)와 같은 방식으로 순수 함수만 모아둔 모듈입니다. DB/HTTP는 server.js가 담당합니다.
//
// 핵심 규칙(2부 규칙서 기준, 이번 대화에서 확정):
//   - 14개 품목을 무작위 순서로 섞어 한 번에 하나씩 경매(품목당 5분 고정 카운트다운)
//   - 경매 중인 품목이 14개 중 무엇인지는 낙찰 전까지 비공개(블라인드) — 시작가 균일(70,000)이라
//     가격으로 정체를 추측할 수 없게 함
//   - 낙찰 즉시 정체 공개 + 낙찰자 상에 추가
//   - 14품목 종료 후 관리자가 준비되면 투표를 열고(5분 고정, 조기 종료 가능), 링크로 접속한
//     시청자가 각 참가자의 완성된 차례상에 투표 → 득표순 최종 순위
//   - 실제 경품은 사람 참가자에게만(관리자/서버가 순위 발표 시 BOT은 별도 표시)
//   - 한 참가자가 낙찰받을 수 있는 품목은 최대 5개(MAX_ITEMS_PER_PLAYER). 5개를 다 채우지
//     않아도 되며, 참가자 화면에 항상 "X / 5" 형태로 현재 몇 개를 낙찰받았는지 보여줍니다.
"use strict";
const crypto = require("crypto");
const DonationEffect = require("./donationEffect.js");

const ITEMS = [
  { slug: "bap", name: "밥" },
  { slug: "guk", name: "국" },
  { slug: "sogogi-sanjeok", name: "소고기 산적" },
  { slug: "dongtaejeon", name: "동태전" },
  { slug: "yukjeon", name: "육전" },
  { slug: "jogigui", name: "조기구이" },
  { slug: "bae", name: "배" },
  { slug: "sagwa", name: "사과" },
  { slug: "yakgwa", name: "약과" },
  { slug: "wakppubol", name: "왁뿌볼" },
  { slug: "mallangi", name: "말랑이" },
  { slug: "dujjonku", name: "두쫀쿠" },
  { slug: "churu", name: "츄르" },
  { slug: "americano", name: "아메리카노" },
];

const START_PRICE = 70000;
const BID_ROUND_MS = 5 * 60 * 1000; // 품목당 5분
const VOTE_MS = 5 * 60 * 1000; // 투표 5분
const BID_INCREMENTS = [10000, 30000, 50000];
// 한 참가자가 낙찰받을 수 있는 품목 수 상한(규칙 추가) — 14개 품목을 소수가 독식하지 못하도록
// 사람/BOT 구분 없이 동일하게 적용합니다. 5개를 다 채우지 않아도 되고, 5개에 도달하면 그
// 참가자는 이후 라운드에서 더 이상 입찰할 수 없습니다(포기와 마찬가지로 조기 낙찰 판단에서는
// "이미 결정된 사람"으로 취급).
const MAX_ITEMS_PER_PLAYER = 5;

// 1부 결산 등수별 2부 시드머니(팔도마블 규칙서 "결산 코드" 절 기준)
const SEED_BY_RANK = { 1: 1250000, 2: 1100000, 3: 950000, 4: 800000 };
// 2부만 단독으로 켰을 때(1부 결과가 없을 때) 임시 기본값 — 2등 기준
const SEED_DEFAULT = 1100000;

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 후원 효과 가격 보정 — 참가자(스트리머)별로 완전히 독립된 후원 집계를 가집니다(1부
// game.js와 동일한 설계). 2부는 낙찰가 결제 시점 한 곳에만 적용하며, "낙찰받는 사람 본인"의
// 누적 보정률을 씁니다(자기 채널 후원이 자기가 내는 낙찰가에 영향). BOT은 채널이 없으므로
// 항상 보정률 0이고, 방 전체 스위치(donationEnabled)를 끄면 누적 기록은 그대로 둔 채 가격에는
// 반영되지 않습니다.
function donationRate(state, playerId) {
  if (state.donationEnabled === false) return 0;
  const p = state.players && state.players[playerId];
  if (p && p.isBot) return 0;
  const de = state.donationEffects && state.donationEffects[playerId];
  return de ? de.cumulativeRate : 0;
}

function donationSummaryForPlayer(state, playerId, forAdmin) {
  const de = (state.donationEffects && state.donationEffects[playerId]) || null;
  return {
    count: de ? de.count : 0,
    cumulativeRate: de ? de.cumulativeRate : 0,
    cumulativeRatePct: de ? Math.round(de.cumulativeRate * 1000) / 10 : 0,
    history: forAdmin ? (de ? de.history.slice(-20) : []) : undefined,
  };
}

// players: [{id, name, isBot, characterId}]
// ranks: { [playerId]: 1|2|3|4 } (선택, 없으면 SEED_DEFAULT)
// part1Assets: { [playerId]: number } (선택, 투표 동률 시 타이브레이커로만 사용)
// existingDonationEffects: 경매 시작 전(waiting) 상태에서 참가자별로 이미 집계된 후원 효과가
// 있으면 이어받기 위한 선택 인자({ [playerId]: donationEffect상태 } 형태, 없으면 빈 맵).
// existingDonationEnabled: 방 전체 후원 효과 켜짐/꺼짐 스위치(기본 true).
function initState(players, ranks, part1Assets, now, existingDonationEffects, existingDonationEnabled) {
  if (!players || players.length < 1) throw new Error("참가자가 최소 1명 이상 있어야 합니다.");
  if (players.length > 4) throw new Error("참가자는 최대 4명까지입니다.");

  const statePlayers = {};
  players.forEach((p) => {
    const rank = ranks && ranks[p.id];
    const seed = rank && SEED_BY_RANK[rank] != null ? SEED_BY_RANK[rank] : SEED_DEFAULT;
    statePlayers[p.id] = {
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      characterId: p.characterId || null,
      seed,
      cash: seed,
      part1Asset: (part1Assets && part1Assets[p.id]) || 0,
      wonItems: [], // [{ slug, name, price }]
    };
  });

  const state = {
    phase: "bidding", // bidding -> table-review -> voting -> ended
    players: statePlayers,
    turnOrder: players.map((p) => p.id),
    itemOrder: shuffledIndices(ITEMS.length), // 서버만 사용, 클라이언트에는 절대 노출하지 않음
    itemResults: [], // 라운드가 끝날 때마다 순서대로 push: { roundIndex, itemIndex, slug, name, winnerId, finalPrice }
    roundPos: 0,
    currentBid: null, // { amount, bidderId }
    itemDeadlineAt: null,
    nextBotThinkAt: null,
    voteDeadlineAt: null,
    votes: {}, // voterKey -> playerId
    results: null, // 투표 마감 후 채워짐
    passedThisRound: [], // 이번 품목에서 "포기"를 누른 사람 참가자 id 목록(품목마다 초기화)
    log: [],
    // 후원 효과(1부·2부 공통 로직, donationEffect.js) — 참가자별로 완전히 독립된 상태를
    // 가집니다(스트리머 B의 후원은 스트리머 B에게만). 경매 시작 전부터 집계된 값이 있으면
    // 이어받고, 없으면 빈 맵에서 시작합니다.
    donationEffects: existingDonationEffects || {},
    donationEnabled: existingDonationEnabled !== false,
  };
  startCurrentRound(state, now);
  state.log.push(`경매 시작 — 품목 14개, 품목당 5분`);
  return state;
}

function startCurrentRound(state, now) {
  state.phase = "bidding";
  state.currentBid = null;
  state.itemDeadlineAt = now + BID_ROUND_MS;
  state.nextBotThinkAt = now + 3000 + crypto.randomInt(5000);
  state.passedThisRound = [];
}

// 현재 최고 입찰자를 제외한 "사람" 참가자가 전원 포기했으면 5분을 다 기다리지 않고 바로
// 낙찰/유찰 처리합니다(실제 경매장의 "더 없습니까? — 낙찰!"과 같은 효과). BOT은 포기 버튼이
// 없고 언제든 무작위 타이밍에 입찰해올 수 있어 "결정 완료 대상"에서 일부러 제외했습니다 —
// BOT은 경품 대상이 아닌 자리채움용이라, 사람 참가자들이 다 정리됐는데도 BOT의 무작위 입찰
// 가능성 때문에 5분을 그대로 기다리게 하는 건 방송 진행상 손해가 더 크다고 판단했습니다.
function maybeResolveEarly(state, now) {
  if (state.phase !== "bidding") return false;
  const leaderId = state.currentBid ? state.currentBid.bidderId : null;
  const undecidedHumans = Object.values(state.players).filter(
    (p) =>
      !p.isBot &&
      p.id !== leaderId &&
      !state.passedThisRound.includes(p.id) &&
      p.wonItems.length < MAX_ITEMS_PER_PLAYER // 이미 5개를 채운 사람은 어차피 입찰할 수 없으므로 "결정 완료"로 취급
  );
  if (undecidedHumans.length > 0) return false;
  // 사람이 아예 없는 방(전원 BOT)에서는 조기 낙찰 대상이 아님 — 포기를 누를 사람이 없으므로
  // 이 조건은 사실상 항상 false지만, 안전하게 한 번 더 명시적으로 확인합니다.
  const anyHuman = Object.values(state.players).some((p) => !p.isBot);
  if (!anyHuman) return false;
  resolveCurrentRound(state, now);
  return true;
}

function currentItem(state) {
  const itemIndex = state.itemOrder[state.roundPos];
  return { itemIndex, ...ITEMS[itemIndex] };
}

function resolveCurrentRound(state, now) {
  const { itemIndex, slug, name } = currentItem(state);
  const bid = state.currentBid;
  let winnerId = null;
  let finalPrice = null; // 실제로 낙찰자가 지불한(후원 효과 보정 후) 금액 — 화면에 표시되는 가격
  let bidAmount = null; // 참고용: 보정 전 원래 입찰 금액
  if (bid) {
    winnerId = bid.bidderId;
    bidAmount = bid.amount;
    // 후원 효과 가격 보정(로드맵 확정 사항: 2부 낙찰가에도 적용) — 낙찰가는 낙찰자 본인의
    // "지출"이므로 낙찰자 자신의 누적 보정률을 씁니다. 긍정 누적 보정률이면 실제로 내는
    // 돈이 줄고, 부정이면 늘어납니다(BOT이 낙찰자면 항상 0 — donationRate 내부에서 보장).
    // 입찰 절차(최소 입찰가·증분 등) 자체는 건드리지 않고, 결제 시점에만 보정합니다.
    finalPrice = DonationEffect.applyExpenditureRate(bidAmount, donationRate(state, winnerId));
    const p = state.players[winnerId];
    p.cash = Math.max(0, p.cash - finalPrice);
    p.wonItems.push({ slug, name, price: finalPrice, bidAmount });
    const priceNote = finalPrice !== bidAmount ? ` (입찰가 ${bidAmount.toLocaleString()}, 후원 효과 보정)` : "";
    state.log.push(`공개! ${name} — ${p.name} 낙찰 (${finalPrice.toLocaleString()}${priceNote})`);
  } else {
    state.log.push(`공개! ${name} — 유찰(입찰 없음)`);
  }
  state.itemResults.push({
    roundIndex: state.roundPos,
    itemIndex,
    slug,
    name,
    winnerId,
    finalPrice,
    bidAmount,
  });

  state.roundPos += 1;
  state.currentBid = null;
  state.itemDeadlineAt = null;
  if (state.roundPos >= ITEMS.length) {
    state.phase = "table-review";
    state.log.push("경매 종료 — 관리자가 투표를 열면 진행됩니다.");
  } else {
    // 예전에는 여기서 바로 startCurrentRound()를 불러 다음 품목으로 자동으로 넘어갔지만,
    // 방송 진행상 낙찰 결과(누가 무엇을 얼마에 가져갔는지)를 화면에 띄우고 멘트를 칠 시간이
    // 필요하다는 요청에 따라 "round-result" 상태에서 멈추도록 바꿨습니다. 다음 품목은
    // 관리자가 advanceRound()(=관리자 화면의 "다음 품목 시작" 버튼)를 눌러야 시작됩니다.
    state.phase = "round-result";
    state.log.push("관리자가 다음 품목을 열면 이어집니다.");
  }
}

// 관리자가 "다음 품목 시작"을 눌렀을 때 호출됩니다. round-result(직전 품목 결과 화면)에서만
// 허용되며, 다음 품목의 5분 타이머를 새로 시작합니다.
function advanceRound(state, now) {
  if (state.phase !== "round-result") {
    throw new Error("지금은 다음 품목을 시작할 수 없습니다.");
  }
  startCurrentRound(state, now);
  state.log.push("다음 품목 시작");
}

function placeBid(state, playerId, amount, now) {
  if (state.phase !== "bidding") throw new Error("지금은 입찰할 수 없습니다.");
  const p = state.players[playerId];
  if (!p) throw new Error("이 게임의 참가자가 아닙니다.");
  if (state.passedThisRound.includes(playerId)) {
    throw new Error("이번 품목은 이미 포기하셨습니다. 다음 품목부터 다시 참여할 수 있어요.");
  }
  if (p.wonItems.length >= MAX_ITEMS_PER_PLAYER) {
    throw new Error(`이미 최대 ${MAX_ITEMS_PER_PLAYER}개 품목을 낙찰받아 더 이상 입찰할 수 없습니다.`);
  }
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("입찰 금액이 올바르지 않습니다.");

  const floor = state.currentBid ? state.currentBid.amount + Math.min(...BID_INCREMENTS) : START_PRICE;
  if (amount < floor) {
    throw new Error(`최소 ${floor.toLocaleString()}원 이상 입찰해야 합니다.`);
  }
  if (state.currentBid && state.currentBid.bidderId === playerId) {
    throw new Error("이미 최고 입찰자입니다.");
  }
  if (amount > p.cash) {
    throw new Error("보유 자금이 부족합니다.");
  }
  state.currentBid = { amount, bidderId: playerId };
  state.log.push(`${p.name}: 미공개 품목에 ${amount.toLocaleString()}원 입찰`);
  maybeResolveEarly(state, now);
}

// 사람 참가자가 이번 품목 입찰을 포기합니다. 현재 최고 입찰자는 포기할 수 없습니다(이미 낙찰
// 후보이므로 — 다른 사람이 더 높은 금액을 부르면 그때 다시 포기할 수 있습니다). 포기는 이번
// 품목 동안 유지되며(새로고침해도 유지, 다음 품목부터는 다시 초기화), 포기 후에는 이번
// 품목에 다시 입찰할 수 없습니다.
function passBidding(state, playerId, now) {
  if (state.phase !== "bidding") throw new Error("지금은 포기할 수 없습니다.");
  const p = state.players[playerId];
  if (!p) throw new Error("이 게임의 참가자가 아닙니다.");
  if (state.currentBid && state.currentBid.bidderId === playerId) {
    throw new Error("현재 최고 입찰자는 포기할 수 없습니다.");
  }
  if (!state.passedThisRound.includes(playerId)) {
    state.passedThisRound.push(playerId);
    state.log.push(`${p.name}: 이번 품목 입찰 포기`);
  }
  maybeResolveEarly(state, now);
}

// 봇은 정체를 모른 채 입찰합니다(사람과 동일 조건). 폴링 주기(1초)를 타고 tick()에서 호출되며,
// 실제 타이머 대신 nextBotThinkAt 기준으로 3~8초마다 한 번씩만 반응하도록 해서 자연스러운 템포를 냅니다.
function maybeBotBid(state, now) {
  if (state.phase !== "bidding") return false;
  if (!state.nextBotThinkAt || now < state.nextBotThinkAt) return false;

  const bots = state.turnOrder
    .map((id) => state.players[id])
    .filter(
      (p) =>
        p.isBot &&
        p.wonItems.length < MAX_ITEMS_PER_PLAYER &&
        (!state.currentBid || state.currentBid.bidderId !== p.id)
    );

  let bid = false;
  for (const bot of shuffleArray(bots)) {
    const floor = state.currentBid ? state.currentBid.amount + Math.min(...BID_INCREMENTS) : START_PRICE;
    const willingness = 0.45; // 봇이 이번 기회에 입찰을 시도할 확률
    if (Math.random() > willingness) continue;
    const step = BID_INCREMENTS[crypto.randomInt(BID_INCREMENTS.length)];
    const amount = floor + (crypto.randomInt(2) === 0 ? 0 : step);
    // 남은 라운드 수를 감안해서 한 품목에 예산을 몰빵하지 않도록: 남은 자금의 60%를 넘기면 포기
    if (amount > bot.cash * 0.6) continue;
    try {
      placeBid(state, bot.id, amount, now);
      bid = true;
    } catch (e) {
      // 조건 안 맞으면 그냥 이번 턴은 패스
    }
    break; // 한 번의 think tick에는 봇 하나만 반응(너무 몰아치지 않게)
  }
  state.nextBotThinkAt = now + 3000 + crypto.randomInt(5000);
  return bid;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startVoting(state, now) {
  if (state.phase !== "table-review") throw new Error("지금은 투표를 열 수 없습니다(경매가 끝난 뒤에만 가능).");
  state.phase = "voting";
  state.voteDeadlineAt = now + VOTE_MS;
  state.votes = {};
  state.log.push("투표 시작 — 5분");
}

function submitVote(state, voterKey, targetPlayerId, now) {
  if (state.phase !== "voting") throw new Error("지금은 투표할 수 없습니다.");
  if (!state.players[targetPlayerId]) throw new Error("존재하지 않는 참가자입니다.");
  if (state.votes[voterKey]) throw new Error("이미 투표하셨습니다.");
  state.votes[voterKey] = targetPlayerId;
}

function voteCounts(state) {
  const counts = {};
  Object.keys(state.players).forEach((id) => (counts[id] = 0));
  Object.values(state.votes).forEach((targetId) => {
    if (counts[targetId] != null) counts[targetId] += 1;
  });
  return counts;
}

function closeVoting(state, now) {
  if (state.phase !== "voting") throw new Error("지금은 투표를 마감할 수 없습니다.");
  const counts = voteCounts(state);
  const ordered = state.turnOrder.slice().sort((a, b) => {
    const diff = counts[b] - counts[a];
    if (diff !== 0) return diff;
    // 동률이면 1부 최종 자산액이 높은 쪽이 우선(제공되지 않았으면 0으로 취급되어 순서 유지)
    return (state.players[b].part1Asset || 0) - (state.players[a].part1Asset || 0);
  });
  const displayRanking = ordered.map((id, i) => ({ playerId: id, rank: i + 1, votes: counts[id] }));
  const prizeRanking = displayRanking
    .filter((r) => !state.players[r.playerId].isBot)
    .map((r, i) => ({ playerId: r.playerId, rank: i + 1, votes: r.votes }));

  state.results = { counts, displayRanking, prizeRanking };
  state.phase = "ended";
  state.log.push("투표 마감 — 최종 순위 확정");
}

function tick(state, now) {
  let changed = false;
  if (state.phase === "bidding") {
    if (maybeBotBid(state, now)) changed = true;
    let guard = 0;
    while (state.phase === "bidding" && state.itemDeadlineAt && now >= state.itemDeadlineAt && guard < ITEMS.length + 1) {
      resolveCurrentRound(state, now);
      changed = true;
      guard++;
    }
  } else if (state.phase === "voting") {
    if (state.voteDeadlineAt && now >= state.voteDeadlineAt) {
      closeVoting(state, now);
      changed = true;
    }
  }
  return changed;
}

// 클라이언트에 보낼 상태를 만듭니다. 경매 중인 품목의 정체는 절대 포함하지 않고,
// 투표 중 득표수는 forAdmin일 때만 포함합니다(밴드왜건 방지, 마감 후에는 전원 공개).
function serializeForClient(state, opts) {
  opts = opts || {};
  // 방을 막 만들었지만 아직 "경매 시작"을 누르기 전에는 state가 { phase: "waiting" }뿐이라
  // state.players가 없습니다. 이 상태로 폴링이 들어와도 죽지 않도록 안전한 기본값을 돌려줍니다.
  if (!state.players) {
    return {
      phase: state.phase || "waiting",
      publicItemList: ITEMS,
      itemResults: [],
      remainingCount: ITEMS.length,
      totalItems: ITEMS.length,
      maxItemsPerPlayer: MAX_ITEMS_PER_PLAYER,
      players: {},
      log: [],
      donationEnabled: state.donationEnabled !== false,
    };
  }
  const players = {};
  Object.values(state.players).forEach((p) => {
    players[p.id] = {
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      characterId: p.characterId,
      cash: p.cash,
      wonItems: p.wonItems,
      // 참가자별 후원 효과 요약 — 누적 개수/보정률뿐이라 정체(블라인드) 노출과 무관하게
      // 항상 내려줘도 안전합니다. 발동 이력(history)은 관리자 화면에서만(forAdmin) 함께
      // 내려줍니다. BOT은 항상 효과가 없지만(donationRate가 0을 보장) 집계 자체는 그대로
      // 보여줘도 무방하므로 굳이 숨기지 않습니다.
      donationEffect: donationSummaryForPlayer(state, p.id, opts.forAdmin),
    };
  });

  const out = {
    phase: state.phase,
    publicItemList: ITEMS,
    itemResults: state.itemResults,
    remainingCount: ITEMS.length - state.itemResults.length,
    totalItems: ITEMS.length,
    maxItemsPerPlayer: MAX_ITEMS_PER_PLAYER,
    players,
    log: state.log.slice(-30),
    donationEnabled: state.donationEnabled !== false,
  };

  if (state.phase === "bidding") {
    out.currentRound = {
      roundNumber: state.roundPos + 1,
      totalRounds: ITEMS.length,
      startPrice: START_PRICE,
      deadlineAt: state.itemDeadlineAt,
      currentBid: state.currentBid,
      passedPlayerIds: state.passedThisRound,
    };
  }
  if (state.phase === "round-result") {
    // 방금 끝난 품목의 결과(정체 공개 + 낙찰자/가격, 유찰이면 winnerId/finalPrice가 null)와
    // 다음 품목 번호를 함께 내려줍니다. 관리자가 "다음 품목 시작"을 누르기 전까지 이 상태로 멈춰 있습니다.
    out.lastResult = state.itemResults[state.itemResults.length - 1] || null;
    out.nextRoundNumber = state.roundPos + 1;
    out.totalRounds = ITEMS.length;
  }
  if (state.phase === "voting") {
    out.voteDeadlineAt = state.voteDeadlineAt;
    out.totalVotes = Object.keys(state.votes).length;
    if (opts.forAdmin) out.voteCounts = voteCounts(state);
  }
  if (state.phase === "ended") {
    out.results = state.results;
  }
  return out;
}

// 관리자 수동 "+1" 버튼 / SOOP 자동 감지가 호출하는 진입점(1부 game.js의 addDonation과
// 동일한 패턴 — 참가자별로 완전히 독립). 경매가 아직 시작 전이거나(waiting) 이미 끝난
// 뒤(ended)라도 방송 자체는 계속되므로 phase는 확인하지 않습니다. donationEffect.js
// 자체는 state.donationEffect(단수) 필드를 다루도록 짜여 있으므로, 여기서는 해당
// 참가자의 상태를 담은 얇은 래퍼 객체를 만들어 넘기고 결과를 state.donationEffects[playerId]에
// 다시 저장합니다(모듈 수정 없이 그대로 재사용).
function addDonation(state, playerId, count, now, source) {
  // 경매 시작 전(waiting)에는 state가 { phase: "waiting" }뿐이라 log 배열이 아직 없을 수 있음
  if (!Array.isArray(state.log)) state.log = [];
  if (!state.donationEffects) state.donationEffects = {};
  const wrapper = { donationEffect: state.donationEffects[playerId] || null };
  const fired = DonationEffect.addDonations(wrapper, count, now, source);
  state.donationEffects[playerId] = wrapper.donationEffect;
  const pname = (state.players && state.players[playerId] && state.players[playerId].name) || playerId;
  fired.forEach((f) => {
    state.log.push(
      `[후원 효과] ${pname} 누적 ${f.atCount}개 — ${f.deltaPct >= 0 ? "+" : ""}${f.deltaPct.toFixed(1)}% (누적 보정률 ${(f.after * 100).toFixed(1)}%)`
    );
  });
  return fired;
}

module.exports = {
  ITEMS,
  START_PRICE,
  BID_ROUND_MS,
  VOTE_MS,
  BID_INCREMENTS,
  MAX_ITEMS_PER_PLAYER,
  SEED_BY_RANK,
  SEED_DEFAULT,
  initState,
  tick,
  placeBid,
  passBidding,
  advanceRound,
  startVoting,
  submitVote,
  closeVoting,
  voteCounts,
  serializeForClient,
  addDonation,
  donationRate,
};
