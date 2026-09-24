// 팔도마블 게임 로직 (순수 함수 모음) - server.js의 applyAction에서 사용
"use strict";
const DonationEffect = require("./donationEffect.js");

const START_CASH = 300000;
// 출발칸 통과 용돈. 2026-09-18에 30,000→70,000원으로 올렸었지만, 밸런스 시뮬레이션 결과
// 통행료 총수입(평균 약 40,000원/회) 대비 GO 용돈이 지나치게 커서(약 8.6배) 거의 파산이
// 안 나고 게임이 자연 종료되지 않는 문제가 드러나, 사용자 확정으로 50,000원으로 재조정.
// 이후 별장/호텔 통행료를 50%/75%로 올린 뒤 다시 시뮬레이션한 결과 자연 종료율이 89%까지
// 개선됐는데, 사용자가 5만/6만/7만원 3단 비교 시뮬레이션을 요청해 검토한 뒤 6만원(자연
// 종료율 73.7%, 보통 속도 기준 자연 종료까지 약 55분 — 5만원 44분과 7만원 1시간30분의
// 중간)으로 최종 확정(2026-09-19).
const GO_BONUS = 60000;
const TOLL_DOUBLE_MS = 90 * 60 * 1000; // 90분

// 건설비: 별장은 토지가의 35%, 호텔은 토지가의 50%(사용자 확정 사항 — 이전에는 둘 다 50%였음).
// 매각환급금은 "건설비의 50%"라는 기존 관계를 그대로 유지해서, 별장은 토지가의 17.5%,
// 호텔은 토지가의 25%를 돌려받습니다(호텔 쪽 금액은 개편 전과 동일).
const VILLA_COST_RATE = 0.35;
const HOTEL_COST_RATE = 0.5;
const VILLA_SELL_RATE = VILLA_COST_RATE * 0.5; // 0.175
const HOTEL_SELL_RATE = HOTEL_COST_RATE * 0.5; // 0.25
function villaCost(tile) {
  return Math.round(tile.price * VILLA_COST_RATE);
}
function hotelCost(tile) {
  return Math.round(tile.price * HOTEL_COST_RATE);
}

// 등수별 기본 경품 + 송편 토큰 업그레이드 단계(규칙서 "종료 조건·결산" 절 기준).
// 송편 토큰 15개 이상이면 1단계 UP, 30개 이상이면 2단계 UP 경품으로 바뀝니다.
const SONGPYEON_TIER1 = 15;
const SONGPYEON_TIER2 = 30;
const PRIZES = [
  { rank: 1, base: "한우 선물세트 10만원대", tier1: "한우 선물세트 15만원대", tier2: "한우 선물세트 24만원대" },
  { rank: 2, base: "곶감 선물세트 5만원대", tier1: "곶감 선물세트 6만원대", tier2: "곶감 선물세트 7만원대" },
  { rank: 3, base: "한과 선물세트 3만원대", tier1: "한과 선물세트 4만원대", tier2: "한과 선물세트 5만원대" },
  { rank: 4, base: "통조림 선물세트 2만원대", tier1: "통조림 선물세트 3만원대", tier2: "통조림 선물세트 4만원대" },
];
function prizeForRank(rank, songpyeon) {
  const entry = PRIZES.find((p) => p.rank === rank);
  if (!entry) return { basePrize: null, songpyeonTier: 0, tierLabel: null, finalPrize: null };
  const tier = songpyeon >= SONGPYEON_TIER2 ? 2 : songpyeon >= SONGPYEON_TIER1 ? 1 : 0;
  const finalPrize = tier === 2 ? entry.tier2 : tier === 1 ? entry.tier1 : entry.base;
  const tierLabel = tier === 2 ? "2단계 UP" : tier === 1 ? "1단계 UP" : "기본";
  return { basePrize: entry.base, songpyeonTier: tier, tierLabel, finalPrize };
}

const TOLL_MULT = { cc: 1.0, jl: 1.1, gs: 1.15, sd: 1.2, jj: 1.2 };

const TILES = [
  { pos: 0, name: "귀성길 출발", type: "start" },
  { pos: 1, name: "대전", type: "city", region: "cc", price: 30000 },
  { pos: 2, name: "세종", type: "city", region: "cc", price: 35000 },
  { pos: 3, name: "복주머니", type: "event", eventType: "market" },
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

// 친척집 미션 3종. 각 미션은 이름(mission)과 "후보 대사" 목록(lines)을 갖습니다 — 칸에
// 도착하면 미션을 랜덤으로 하나 고르고, 대사가 있는 미션(사투리 따라하기/애교 미션)은 그중
// 대사도 하나 랜덤으로 골라 참가자 화면에 함께 보여줍니다(무엇을 어떻게 수행해야 하는지
// 바로 알 수 있도록). 노래10초 미션은 정해진 대사가 없으므로 lines를 비워둡니다 — 참가자가
// 부르고 싶은 노래를 자유롭게 10초 이상 부르면 됩니다(player.html의 renderEventArea 참고).
const MISSION_TYPES = [
  {
    name: "사투리 따라하기",
    lines: [
      "가가 가라고? 아이다. 가가 가가 아니고 가가 가다.",
      "니 내 누군지 아나? 돈 받으러 왔는데 뭐 그거까지 알아야 되니?",
      "느그 서장 남천동 살제? 내가 임마, 느그 서장이랑 밥도 묵고! 사우나도 같이 가고!",
      "와, 이거 맛꿀마. 맛이 아주 깔끼하네예. 이거는 인정해뿌야 됩니다.",
      "니 지금 왜 그러는데? 너 와카는데? 와칸다 포에버",
    ],
  },
  {
    name: "애교 미션",
    lines: [
      "야 라고 해도 돼? 내꺼라고 해도 돼? 우리둘만 아는 애칭이 필요해. 으른양 으른양. 그러니까 오늘부터 내꺼해.",
      "있지… 쓰다듬어줘 안돼…? 그럼 안아줘 그것도 안돼..? 그럼 뽀뽀해줘.. 그것도? 해줘! 해줘! ..그냥 내가 하지 뭐 쪽~♡♡",
      "옵빠! 나 띠드버거 먹고띠퍼요! 띠드버거~~ 아 빨리 띠드버거~~",
      "변신 귀엽 뽁짝 애교와 귀여움으로 펼쳐진 (본인이름)! (팬덤닉)들의 지갑을 사로잡아버리겠어 하트 발쌰 뿅♥뿅♥",
      "나는 고미니이따 싯빵이에 누었는데 너무 푹씨내서 이러날슈가 업따 오또카지",
    ],
  },
  {
    name: "노래10초 미션",
    lines: [],
  },
];

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

// 0~1 사이로 안전하게 자름(숫자가 아니거나 범위를 벗어나면 fallback값, 기본 0.6).
function clampVolume(v, fallback) {
  const fb = typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0.6;
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// state.log(화면에 보여주는 "진행 기록" 텍스트 줄)에 새 줄을 추가하는 전용 함수입니다.
// ★ 실제로 있었던 문제: 예전에는 이 배열이 게임이 아무리 길어져도 계속 무한정 쌓이기만
// 했는데, 참가자 화면이 1초마다 상태 전체(state 전체, 이 log 배열 포함)를 서버에 요청해서
// 받아가는 구조라, 게임이 길어질수록 매 요청·매 응답이 점점 무거워졌습니다. 특히 여러 기기가
// 동시에 폴링하는 상황에서 서버가 한 번에 여러 요청을 처리해야 할 때, 이렇게 무거워진 응답
// 하나하나가 조금씩 더 오래 걸리기 시작하면 다음 요청들이 그 뒤에 밀려서 쌓이고, 쌓인
// 요청이 많아질수록 각각이 더 오래 기다리게 되는 식으로 전체 응답이 눈덩이처럼 느려지는
// 사고(참가자 화면이 한동안 먹통이 되는 현상)로 이어질 수 있었습니다.
// 그래서 화면에 보여주는 배열 자체는 LOG_KEEP개(최근 것)만 남기고 오래된 줄은 잘라내되,
// "몇 번째로 생긴 사건인지"를 나타내는 값은 배열 길이가 아니라 절대 줄어들지 않는 별도의
// 카운터(state.logSeq)로 따로 관리합니다 — 이 값은 아래 pushResultLog의 atLogLen(참가자
// 화면이 "새로 생긴 결과인지" 판단하는 기준)으로도 그대로 쓰이는데, 만약 배열 길이를 그대로
// atLogLen으로 썼다면 배열이 잘려서 길이가 줄어드는 순간 그 판단이 틀어져 팝업이 중복되거나
// 아예 안 뜨는 문제가 생겼을 것이기 때문입니다.
const LOG_KEEP = 200;
function pushLog(state, line) {
  if (!Array.isArray(state.log)) state.log = [];
  state.log.push(line);
  // logSeq가 아직 없는 상태(이 수정 이전에 저장된 게임을 이어서 부르는 경우 등)라면 지금까지의
  // log.length를 이어받아 시작합니다 — 이 값이 정확히 몇 번째인지보다는, 앞으로 절대 줄어들지
  // 않고 계속 증가하기만 하면 되므로 이 정도 근사로 충분합니다.
  state.logSeq = (typeof state.logSeq === "number" ? state.logSeq : state.log.length) + 1;
  if (state.log.length > LOG_KEEP) state.log.splice(0, state.log.length - LOG_KEEP);
}

// ---------------------------------------------------------------------------
// 참가자 화면(player.html)에 "무슨 일이 있었는지" 팝업으로 보여주기 위한 결과 기록입니다.
// ★ 예전에는 state.lastEventResult/state.lastTollResult처럼 "가장 최근 결과 하나"만
// 담는 필드였는데, 실제로 있었던 문제: BOT이 여러 명이면 사람이 한 번 폴링(약 1초)하는
// 사이에 BOT 턴이 연달아(최대 60턴까지) 서버 한 번의 요청 처리 안에서 곧바로 다 진행돼
// 버립니다(runBotsIfNeeded 참고). 그 사이에 나와 관련된 결과(예: 내 땅에 통행료가 두 번
// 들어옴)가 여러 번 생기면, "최근 값 하나"만 남기는 방식으로는 먼저 생긴 결과가 나중 결과에
// 덮어써져서 그대로 사라져버립니다 — 팝업이 아예 안 뜨는 것처럼 보이는 사고였습니다.
// 그래서 최근 결과 하나만 저장하지 않고, 배열(resultLog)에 계속 쌓아두고 각 참가자 화면이
// "내가 마지막으로 확인한 atLogLen 이후에 새로 생긴 것 중 내 것" 전부를 찾아서 차례로
// 보여주는 방식으로 바꿨습니다. atLogLen은 그 결과가 기록된 시점의 state.logSeq 값이라
// 게임 안에서 항상 유일하고(위 pushLog 참고 — state.log 배열이 잘려도 절대 줄어들지
// 않습니다) 단조 증가하므로, 이것만으로도 순서/중복 판단에 충분합니다.
// entry는 kind가 "event"(복주머니/친척집/달토끼상점/복불복윷판/고속도로정체/송편가게)이면
// playerId 하나에게만, kind가 "toll"(통행료)이면 payerId(낸 사람)/ownerId(땅주인) 두
// 사람에게 각각 보여줍니다.
function pushResultLog(state, entry) {
  if (!Array.isArray(state.resultLog)) state.resultLog = [];
  state.resultLog.push(entry);
  // 메모리/저장 용량이 무한정 늘어나지 않도록 최근 것만 남깁니다. 서버 요청 한 번에 BOT이
  // 최대 60턴까지 연달아 진행될 수 있으므로(runBotsIfNeeded의 guard), 그보다 넉넉히 큰
  // 값으로 잡아 어떤 경우에도 한 번의 폴링 사이에 생긴 결과가 잘리지 않게 합니다.
  if (state.resultLog.length > 400) state.resultLog.splice(0, state.resultLog.length - 400);
}

// ---------------------------------------------------------------------------
// existingDonationEffects: 게임 시작 전(waiting) 상태에서 관리자가 이미 참가자별 후원을
// 집계해뒀다면(수동 +1 버튼/SOOP 자동감지를 게임 시작 전부터 켜둔 경우) 그 값을 이어받기
// 위한 선택 인자입니다({ [playerId]: donationEffect상태 } 형태). 넘기지 않으면 빈 맵으로 시작.
// existingDonationEnabled: 방 전체 후원 효과 켜짐/꺼짐 스위치(기본 true).
// existingAudioSettings: 게임 시작 전(waiting)부터 관리자가 효과음 음량을 미리 맞춰뒀을 수
// 있으므로, 있으면 그대로 이어받습니다(donationEffects와 동일한 패턴).
function initState(players, existingDonationEffects, existingDonationEnabled, existingAudioSettings) {
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
    // 복불복 윷판/친척집 미션/통행료처럼 "이번에 정확히 무슨 일이 있었는지"를 참가자 화면에서
    // 크게 강조해 보여주기 위한 구조화된 결과 기록(로그 텍스트를 파싱하지 않고 바로 읽게 함).
    // ★ "가장 최근 결과 하나"만 담던 예전 필드(lastEventResult/lastTollResult)를
    // pushResultLog로 계속 쌓이는 배열로 교체했습니다 — 자세한 이유는 위 pushResultLog
    // 함수의 주석 참고(BOT 연속 턴 중 결과가 덮어써져 사라지는 문제 수정).
    resultLog: [],
    winnerId: null,
    log: ["게임을 시작합니다."],
    // log 배열이 나중에(LOG_KEEP을 넘어서면) 잘려도 atLogLen 판단이 틀어지지 않도록, 배열
    // 길이와 별개로 절대 줄어들지 않는 카운터입니다(위 pushLog 함수 주석 참고). 초기 로그
    // 1줄과 맞춰 1에서 시작합니다.
    logSeq: 1,
    players: {},
    properties: {},
    donationEffects: existingDonationEffects || {},
    donationEnabled: existingDonationEnabled !== false,
    // 참가자 화면(player.html)의 효과음을 관리자 화면에서 방 전체에 동일하게 음량 조절할 수
    // 있도록 방 상태에 함께 둡니다(사용자 확정: 방 전체 공유 설정, 서버 저장). sfxVolume은
    // 0~1 사이 값(HTML5 Audio.volume과 동일한 범위)이며, 효과음은 시작부터 켜진 상태(기본
    // 음량 0.6)입니다. (BGM 기능은 사용자 요청으로 완전히 제거했습니다.)
    audioSettings:
      existingAudioSettings && typeof existingAudioSettings === "object"
        ? { sfxVolume: clampVolume(existingAudioSettings.sfxVolume, 0.6) }
        : { sfxVolume: 0.6 },
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

// 요청: "권역 보너스 모두 제거" — 한 권역의 도시를 전부 소유하면 통행료 등급이
// 0.1→0.2로 올라가던 "올소유 보너스"를 없앴습니다(사용자 확정: 이 보너스만 제거, 권역마다
// 다른 기본 배율(TOLL_MULT)은 그대로 유지). 이제 통행료 등급은 땅/별장/호텔 여부로만 정해집니다.
function tollFor(state, pos, now) {
  const tile = TILES[pos];
  const prop = state.properties[pos] || { ownerId: null, villa: false, hotel: false };
  const mult = TOLL_MULT[tile.region];
  let tier;
  // 밸런스 시뮬레이션 결과, 도시 칸이 초반(10~20라운드) 안에 거의 다 팔린 뒤로는 건설/통행료만으로
  // 후반부 긴장감을 만들어야 하는데 기존 배율(별장 30%/호텔 60%)로는 GO 용돈의 경제적 우위를 못
  // 이기는 것으로 나타나, 사용자 확정으로 별장 30%→50%, 호텔 60%→75%로 상향(땅만 소유 10%는 유지).
  if (prop.hotel) tier = 0.75;
  else if (prop.villa) tier = 0.5;
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
  const prop = state.properties[pos] || { ownerId: null, villa: false, hotel: false };
  const mult = TOLL_MULT[tile.region];
  let tier;
  if (prop.hotel) tier = 0.75;
  else if (prop.villa) tier = 0.5;
  else tier = 0.1;
  let amount = Math.round(tile.price * tier * mult);
  if (state.gameStartedAt && now - state.gameStartedAt > TOLL_DOUBLE_MS) amount *= 2;
  return amount;
}

// 별장/호텔은 이제 서로 독립된 건물이라(단계식 사다리가 아님) 매각도 "원하는 부분만"
// 골라서 할 수 있습니다. part: "villa" | "hotel" | "land". 땅(land)은 그 위에 별장/호텔이
// 남아있지 않을 때만 매각할 수 있습니다(건물부터 각각 정리한 뒤 땅을 매각).
// 매각환급금은 후원 효과 적용 범위에서 제외됩니다(통행료만 적용 — 사용자 확정 사항).
function sellPiece(state, pos, part) {
  const tile = TILES[pos];
  const prop = state.properties[pos];
  if (!prop || !prop.ownerId) return 0;
  if (part === "villa") {
    if (!prop.villa) throw new Error("매각할 별장이 없습니다.");
    prop.villa = false;
    return Math.round(tile.price * VILLA_SELL_RATE);
  }
  if (part === "hotel") {
    if (!prop.hotel) throw new Error("매각할 호텔이 없습니다.");
    prop.hotel = false;
    return Math.round(tile.price * HOTEL_SELL_RATE);
  }
  if (part === "land") {
    if (prop.villa || prop.hotel) throw new Error("땅을 매각하려면 먼저 별장/호텔을 매각해야 합니다.");
    const refund = Math.round(tile.price * 0.5);
    delete state.properties[pos];
    return refund;
  }
  throw new Error("알 수 없는 매각 대상입니다.");
}

// 빚을 갚기 위한 자동(강제) 청산 전용: 사람이 직접 고르는 것이 아니라 서버가 순서대로
// (호텔 → 별장 → 땅) 하나씩 팔아나갑니다. 기존 동작과 동일한 우선순위를 유지합니다.
function forceLiquidateOneStep(state, pos) {
  const prop = state.properties[pos];
  if (!prop || !prop.ownerId) return 0;
  if (prop.hotel) return sellPiece(state, pos, "hotel");
  if (prop.villa) return sellPiece(state, pos, "villa");
  return sellPiece(state, pos, "land");
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
      const refund = forceLiquidateOneStep(state, pos);
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
    if (prop.villa) total += Math.round(tile.price * 0.5);
    if (prop.hotel) total += Math.round(tile.price * 0.5) * 2;
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
      isBot: !!state.players[id].isBot,
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
      isBot: !!state.players[id].isBot,
      cash: 0,
      assetValue: 0,
      netWorth: 0,
      songpyeon: state.players[id].songpyeon,
      bankrupt: true,
    }));

  // 등수(rank)가 확정된 뒤에야 경품을 매길 수 있으므로(경품은 "등수" 기준), rank를 먼저
  // 채우고 나서 prizeForRank를 호출합니다. 경품은 사람 참가자에게만 지급되지만(규칙서
  // 기준), BOT 항목에도 "만약 사람이었다면"의 참고용 경품 정보를 동일하게 채워 넣고
  // 화면에서 isBot으로 구분해 표시하도록 둡니다.
  return [...aliveRanked, ...bankruptRanked].map((r, i) => {
    const rank = i + 1;
    return { ...r, rank, ...prizeForRank(rank, r.songpyeon) };
  });
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
  pushLog(state, `${p.name} 파산했습니다.`);
  const alive = state.turnOrder.filter((id) => !state.players[id].bankrupt);
  if (alive.length <= 1) {
    state.phase = "ended";
    state.winnerId = alive[0] || null;
    state.turnPhase = "ended";
    state.finalRanking = computeFinalRanking(state);
    pushLog(state, alive[0] ? `게임 종료! 승자: ${state.players[alive[0]].name}` : "게임 종료!");
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
    pushLog(state, "남은 참가자가 모두 BOT이라 자동으로 종료하고 자산 기준으로 순위를 정산했습니다.");
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
  pushLog(state, "관리자가 게임을 강제 종료하고, 현재 자산 기준으로 순위를 정산했습니다.");
  return state;
}

// 관리자가 특정 참가자를 원하는 칸으로 강제로 옮기는 기능(사용자 확정 사항: "특정 칸으로
// 이동시킬 수 있는 기능"). 방송 진행 중 위치를 바로잡거나 연출을 위해 즉시 옮겨야 할 때 씁니다.
// 도시 칸은 위치만 옮기고 통행료/구매는 자동 처리하지 않습니다(의도치 않게 돈이 오가지
// 않도록). 다만 이벤트 칸(친척집/달토끼 상점/복주머니/고속도로 정체/송편가게/윷판)으로
// 옮긴 경우는 사용자 확정 사항에 따라 실제로 그 칸에 착지한 것과 똑같이 이벤트가 즉시
// 발동됩니다.
function adminMovePlayer(state, playerId, tilePos, now) {
  if (state.phase !== "playing") throw new Error("지금은 게임이 진행 중이 아닙니다.");
  const p = state.players[playerId];
  if (!p) throw new Error("이 게임의 참가자가 아닙니다.");
  if (p.bankrupt) throw new Error("이미 파산한 참가자는 이동시킬 수 없습니다.");
  const pos = Number(tilePos);
  if (!Number.isInteger(pos) || pos < 0 || pos >= TILES.length) {
    throw new Error("올바르지 않은 칸 번호입니다(0~" + (TILES.length - 1) + ").");
  }
  const fromTile = TILES[p.position];
  const toTile = TILES[pos];
  p.position = pos;
  pushLog(state,
    `(관리자) ${p.name}: ${fromTile ? fromTile.name : p.position}번 칸 → ${toTile.name}(${pos}번) 칸으로 강제 이동`
  );

  if (toTile.type === "event") {
    // 이벤트를 직접 고를 수 있어야 하는 경우(복주머니/친척집/달토끼 상점)는 이동된 참가자가
    // 자기 화면에서 바로 선택할 수 있어야 하므로, 이 참가자를 곧바로 "지금 차례"로 넘겨서
    // 처리합니다. 마침 다른 사람의 턴이 진행 중이었다면 이 강제 이벤트가 그 턴을 대체합니다
    // — 관리자가 의도적으로 개입하는 상황이므로 정상 동작입니다.
    if (state.currentPlayerId && state.currentPlayerId !== playerId) {
      const other = state.players[state.currentPlayerId];
      pushLog(state, `(관리자) 진행 중이던 ${other ? other.name : "?"}의 턴을 대신하고, 강제 이벤트를 처리합니다.`);
    }
    const idx = state.turnOrder.indexOf(playerId);
    if (idx !== -1) state.currentIdx = idx;
    state.currentPlayerId = playerId;
    state.pendingToll = null;
    startEvent(state, playerId, toTile, now || Date.now());
    if (p.bankrupt) {
      advanceTurn(state);
    } else if (p.isBot) {
      // BOT은 화면에서 직접 버튼을 누를 수 없으니, 평소 봇 턴과 동일하게 즉시 자동으로
      // 골라 처리하고 다음 사람 턴으로 넘어갑니다.
      if (state.turnPhase === "awaiting-event") {
        botResolveEvent(state, playerId, now || Date.now());
        if (p.bankrupt) {
          advanceTurn(state);
          return state;
        }
      }
      maybeBotBuild(state, playerId);
      advanceTurn(state);
    }
  }
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
// 결과 이름(도/개/걸/윷/모)까지 함께 돌려줘서 참가자 화면에 "어떤 결과가 나와서 얼마를
// 받았는지"를 금액만이 아니라 눈으로 보이는 값으로도 표시할 수 있게 합니다(사용자 요청).
// 확률/금액 자체는 기존 그대로입니다: 도 40%: +5,000 · 개 25%: +10,000 · 걸 20%: -10,000 ·
// 윷 10%: +25,000 · 모 5%: -25,000.
function rollYut() {
  const r = Math.random();
  if (r < 0.4) return { label: "도", delta: 5000 };
  if (r < 0.65) return { label: "개", delta: 10000 };
  if (r < 0.85) return { label: "걸", delta: -10000 };
  if (r < 0.95) return { label: "윷", delta: 25000 };
  return { label: "모", delta: -25000 };
}

function startEvent(state, playerId, tile, now) {
  const p = state.players[playerId];
  if (tile.eventType === "market") {
    state.pendingEvent = { type: "market", cards: generateMarketCards() };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "relative") {
    // 미션을 랜덤으로 고르고, 그 미션에 후보 대사가 있으면(사투리 따라하기/애교 미션) 그중
    // 하나도 함께 랜덤으로 골라 mission(미션 이름)과 missionLine(수행할 대사)으로 각각
    // 내려줍니다 — 노래10초 미션은 후보 대사가 없으므로 missionLine은 null입니다
    // (player.html의 renderEventArea가 null이면 "직접 노래를 불러달라"는 안내만 보여줌).
    const mt = MISSION_TYPES[Math.floor(Math.random() * MISSION_TYPES.length)];
    const missionLine = mt.lines.length ? mt.lines[Math.floor(Math.random() * mt.lines.length)] : null;
    state.pendingEvent = { type: "relative", mission: mt.name, missionLine };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "shop") {
    state.pendingEvent = { type: "shop" };
    state.turnPhase = "awaiting-event";
  } else if (tile.eventType === "traffic") {
    p.nextRollPenalty = true;
    pushLog(state, `${p.name}: 고속도로 정체 (다음 이동 -1)`);
    // 사용자 요청("모든 이벤트를 전부 팝업 표시"): 현금 증감이 없는 이벤트도 결과를 알 수
    // 있도록 팝업 큐에 남깁니다. amount가 없으므로 효과음(sfx)은 울리지 않습니다.
    pushResultLog(state, { kind: "event", type: "traffic", playerId, atLogLen: state.logSeq });
    state.turnPhase = "awaiting-endturn";
  } else if (tile.eventType === "songpyeon") {
    const n = 5 + Math.floor(Math.random() * 6); // 5~10개(사용자 확정 사항 — 이전에는 1~3개)
    p.songpyeon += n;
    pushLog(state, `${p.name}: 송편 토큰 +${n} (누적 ${p.songpyeon})`);
    // 위 traffic과 동일한 이유로 팝업 큐에 남깁니다(현금 증감 없음 → 효과음 없음).
    pushResultLog(state, { kind: "event", type: "songpyeon", count: n, totalSongpyeon: p.songpyeon, playerId, atLogLen: state.logSeq });
    state.turnPhase = "awaiting-endturn";
  } else if (tile.eventType === "yut") {
    const { label, delta } = rollYut();
    if (delta >= 0) p.cash += delta;
    else chargePlayer(state, playerId, -delta, now);
    pushLog(state, `${p.name}: 복불복 윷판 결과 "${label}" ${delta >= 0 ? "+" : ""}${delta.toLocaleString()}원`);
    // playerId를 함께 남겨두는 이유: 누구 화면에 팝업으로 보여줘야 하는지 참가자 화면
    // (player.html)에서 정확히 구분하기 위해서입니다(실제로 있었던 버그: 이게 없으면 BOT이나
    // 다른 참가자 턴에 생긴 결과가, 그 이후 내 턴이 됐을 때 마치 내 결과인 것처럼 뒤늦게
    // 잘못 표시될 수 있었습니다). pushResultLog를 쓰는 이유는 파일 상단 주석 참고(BOT 연속
    // 턴 중 결과가 덮어써져 사라지는 문제 수정).
    pushResultLog(state, { kind: "event", type: "yut", label, delta, playerId, atLogLen: state.logSeq });
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
    pushLog(state, `${p.name}: 복주머니 카드 결과 ${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`);
    // 요청: "모든 이벤트 결과는 윷놀이 결과와 동일한 방식으로 팝업으로 안내" (수입/지출
    // 이벤트 한정) — 복주머니도 현금 증감이 있는 이벤트이므로 yut/relative와 같은
    // pushResultLog 패턴을 따릅니다. playerId를 남겨두는 이유는 위 rollYut 쪽 주석 참고
    // (누구 화면에 보여줘야 할 결과인지 구분하기 위함 — BOT/다른 참가자 결과가 내 턴에
    // 뒤늦게 잘못 뜨는 걸 막는 용도).
    pushResultLog(state, { kind: "event", type: "market", amount: delta, playerId, atLogLen: state.logSeq });
  } else if (ev.type === "relative") {
    if (choice === "perform") {
      const bonus = 5000 + Math.floor(Math.random() * 6) * 1000;
      p.cash += bonus;
      pushLog(state, `${p.name}: 친척집 미션 성공! +${bonus.toLocaleString()}원`);
      pushResultLog(state, { kind: "event", type: "relative", outcome: "success", amount: bonus, playerId, atLogLen: state.logSeq });
    } else {
      // 패스하면 어떤 경우에도 돈을 받지 못합니다(사용자 확정 사항) — 기존에도 그랬지만,
      // 참가자 화면에서 "0원"임이 분명히 보이도록 로그·결과 배너 문구를 명확히 함.
      pushLog(state, `${p.name}: 친척집 미션 패스 (획득 금액 없음)`);
      pushResultLog(state, { kind: "event", type: "relative", outcome: "pass", amount: 0, playerId, atLogLen: state.logSeq });
    }
  } else if (ev.type === "shop") {
    const item = ["toll-free", "reroll", "half-build"].includes(choice) ? choice : null;
    if (item && p.cash >= 15000) {
      p.cash -= 15000;
      p.items.push(item);
      pushLog(state, `${p.name}: 달토끼 상점에서 ${itemLabel(item)} 구매`);
      // 아이템 구매는 15,000원 지출 이벤트이므로 다른 수입/지출 이벤트와 동일하게
      // pushResultLog로 남겨 참가자 화면에 팝업으로 안내합니다.
      pushResultLog(state, { kind: "event", type: "shop", outcome: "bought", item, amount: -15000, playerId, atLogLen: state.logSeq });
    } else {
      pushLog(state, `${p.name}: 달토끼 상점 패스`);
      pushResultLog(state, { kind: "event", type: "shop", outcome: "pass", item: null, amount: 0, playerId, atLogLen: state.logSeq });
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
    pushLog(state, `${p.name}: 통행료 면제권 사용`);
    amount = 0;
  }
  if (amount > 0) {
    const paid = chargePlayer(state, playerId, amount, now);
    const owner = state.players[pending.ownerId];
    if (owner && paid > 0) owner.cash += paid;
    pushLog(state,
      `${p.name} → ${owner ? owner.name : "?"} 통행료 ${paid.toLocaleString()}` +
        (paid < amount ? " (자금 부족으로 파산)" : "")
    );
    // 사용자 요청: "통행료 수입과 통행료 지출도 팝업에 반영". 통행료는 지불하는 사람(지출)과
    // 땅주인(수입) 두 사람에게 동시에 영향을 주는 이벤트라, kind: "event"(항상 "지금 내
    // 턴인 사람"의 결과만 다룸)와는 별도로 kind: "toll" 항목에 payerId/ownerId를 모두
    // 남깁니다 — 땅주인은 자기 턴이 아닐 때(남이 내 땅을 밟았을 때) 통행료를 받으므로,
    // 참가자 화면(player.html)이 이 둘 중 자기 id와 맞는 쪽을 각자 판단해서 지불한 사람에게는
    // 지출로, 땅주인에게는 수입으로 따로 보여줍니다. pushResultLog를 쓰는 이유는 파일 상단
    // 주석 참고(BOT 연속 턴 중 여러 번 통행료가 발생해도 하나도 빠짐없이 큐에 쌓입니다).
    if (owner && paid > 0) {
      pushResultLog(state, {
        kind: "toll",
        payerId: playerId,
        payerName: p.name,
        ownerId: pending.ownerId,
        ownerName: owner.name,
        amount: paid,
        bankrupt: paid < amount,
        atLogLen: state.logSeq,
      });
    }
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
  // 고속도로 정체로 인한 -1칸 페널티가 걸려 있었는지는 아래에서 소비(false로 리셋)해
  // 버리기 전에 따로 기억해둡니다 — 이번에 도착한 칸이 "정체 때문에 어쩔 수 없이 멈춘
  // 칸"인지를 이후 도시 구매 처리에서 구분해야 하기 때문입니다(사용자 확정 사항:
  // "-1칸 이동은 유지, 도착한 칸이 도시면 구매 불가도 유지, 도시가 아니면 이벤트는 정상 진행").
  const wasPenalized = !!p.nextRollPenalty;
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
  pushLog(state, `${p.name}: 주사위 ${roll}${stayed ? " (정체로 이동 없음)" : ""}`);
  if (stayed) {
    state.turnPhase = "awaiting-endturn";
    return;
  }
  if (passedGo || newPos === 0) {
    p.cash += GO_BONUS;
    pushLog(state, `${p.name}: 귀성길 출발 통과, 용돈 +${GO_BONUS.toLocaleString()}`);
  }
  const tile = TILES[newPos];
  if (tile.type === "start") {
    state.turnPhase = "awaiting-endturn";
    return;
  }
  if (tile.type === "city") {
    const prop = state.properties[tile.pos];
    if (!prop || !prop.ownerId) {
      if (wasPenalized) {
        // 고속도로 정체로 밀려서 도착한 빈 땅은 이번 턴엔 구매할 수 없습니다(사용자 확정 사항).
        pushLog(state, `${p.name}: 고속도로 정체로 밀려 도착한 칸이라 이번엔 구매할 수 없습니다.`);
        state.turnPhase = "awaiting-endturn";
        return;
      }
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

function maybeBotBuild(state, playerId) {
  const p = state.players[playerId];
  // 별장/호텔은 단계식이 아니라 각자 독립적으로 지을 수 있고, 권역을 전부 소유해야 한다는
  // 조건도 없습니다(사용자 확정 사항: "자금 여력에 따라 구매 가능"). 다만 건설은 지금 그
  // 칸에 있을 때만 할 수 있다는 규칙(사용자 확정 사항: "내 차례에 해당 도시의 칸에 있어야만
  // 건설 가능")은 BOT에게도 똑같이 적용해서, 사람과 형평성이 어긋나지 않게 합니다 — 그래서
  // 소유한 모든 땅이 아니라 지금 BOT이 서 있는 칸 하나만 검사합니다.
  const pos = p.position;
  const prop = state.properties[pos];
  if (prop && prop.ownerId === playerId) {
    const tile = TILES[pos];
    // 건설비는 후원 효과 적용 범위 밖(통행료만 적용). 별장·호텔은 건설비가 서로 다름.
    const vCost = villaCost(tile);
    const hCost = hotelCost(tile);
    if (!prop.villa && p.cash - vCost >= 20000) {
      p.cash -= vCost;
      prop.villa = true;
      pushLog(state, `${p.name}(BOT): ${tile.name}에 별장 건설`);
    }
    if (!prop.hotel && p.cash - hCost >= 20000) {
      p.cash -= hCost;
      prop.hotel = true;
      pushLog(state, `${p.name}(BOT): ${tile.name}에 호텔 건설`);
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
    // 요청: "권역 보너스 모두 제거" — 권역을 전부 채우면 이득이던 시절에는 BOT이 자금 여력이
    // 빠듯해도 "이번 구매로 권역이 완성되면" 무리해서 사도록 했지만, 그 보너스가 없어졌으므로
    // 이제는 순수하게 여윳돈(20,000원 이상 남는지)만 보고 삽니다.
    if (price <= p.cash && afford >= 20000) {
      state.properties[tile.pos] = { ownerId: pid, villa: false, hotel: false };
      p.cash -= price;
      pushLog(state, `${p.name}(BOT): ${tile.name} 구매`);
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
      state.properties[tile.pos] = { ownerId: playerId, villa: false, hotel: false };
      pushLog(state, `${p.name}: ${tile.name} 구매`);
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
      // 복주머니 카드에서 큰 손해를 봐서 파산했을 수도 있음 → 그 경우 곧바로 다음 사람 턴으로
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
      // 건설은 지금 내가 그 칸에 있을 때만 할 수 있습니다(사용자 확정 사항: "내 차례에 해당
      // 도시의 칸에 있어야만 건설 가능"). 다른 칸에 있으면서 예전에 사둔 땅을 원격으로
      // 건설하는 것은 더 이상 허용하지 않습니다.
      if (p.position !== pos) throw new Error("지금 그 칸에 있어야 건설할 수 있습니다.");
      // 별장/호텔은 단계식으로 거치지 않고 각각 독립적으로 지을 수 있으며(사용자 확정 사항:
      // "자금 여력에 따라 구매 가능"), 권역을 전부 소유해야 한다는 조건도 없습니다.
      // 한 칸에는 별장·호텔을 각각 최대 1개씩(동시에) 보유할 수 있습니다.
      let cost;
      if (payload.level === "villa") {
        if (prop.villa) throw new Error("이미 별장이 있습니다.");
        cost = villaCost(tile); // 건설비는 후원 효과 적용 범위 밖(통행료만 적용)
      } else if (payload.level === "hotel") {
        if (prop.hotel) throw new Error("이미 호텔이 있습니다.");
        cost = hotelCost(tile); // 건설비는 후원 효과 적용 범위 밖(통행료만 적용)
      } else {
        throw new Error("알 수 없는 건물 종류입니다.");
      }
      if (payload?.useItem) {
        const halfIdx = p.items.indexOf("half-build");
        if (halfIdx === -1) throw new Error("보유한 건설비 반값권이 없습니다.");
        cost = Math.round(cost * 0.5);
        p.items.splice(halfIdx, 1);
        pushLog(state, `${p.name}: 건설비 반값권 사용`);
      }
      if (p.cash < cost) throw new Error("자금이 부족합니다.");
      p.cash -= cost;
      if (payload.level === "villa") prop.villa = true;
      else prop.hotel = true;
      pushLog(state, `${p.name}: ${tile.name}에 ${payload.level === "villa" ? "별장" : "호텔"} 건설`);
      break;
    }
    case "sell-property": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("지금은 매각할 수 없습니다.");
      const pos = payload?.tilePos;
      const prop = state.properties[pos];
      if (!prop || prop.ownerId !== playerId) throw new Error("본인 소유의 땅이 아닙니다.");
      // 이제 단계별(호텔→별장→땅)로 순서대로 내려가며 매각하지 않고, 별장/호텔/땅 중
      // 원하는 부분만 골라서 매각할 수 있습니다(사용자 확정 사항).
      const part = payload?.part;
      const tileName = TILES[pos] ? TILES[pos].name : "";
      const refund = sellPiece(state, pos, part);
      p.cash += refund;
      const partLabel = part === "villa" ? "별장" : part === "hotel" ? "호텔" : "땅";
      pushLog(state, `${p.name}: ${tileName} ${partLabel} 매각 +${refund.toLocaleString()}`);
      break;
    }
    case "use-item": {
      assertCurrentTurn(state, playerId);
      if (state.turnPhase !== "awaiting-endturn") throw new Error("지금은 아이템을 쓸 수 없습니다.");
      if (payload?.item !== "reroll") throw new Error("지금 쓸 수 있는 아이템이 아닙니다.");
      const idx = p.items.indexOf("reroll");
      if (idx === -1) throw new Error("보유한 재굴림권이 없습니다.");
      p.items.splice(idx, 1);
      pushLog(state, `${p.name}: 주사위 재굴림권 사용`);
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
    pushLog(state,
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
  pushLog,
  initState,
  applyPlayerAction,
  runBotsIfNeeded,
  tollFor,
  tollForPlain,
  forceEndGame,
  adminMovePlayer,
  computeFinalRanking,
  netWorth,
  assetValue,
  addDonation,
  donationRate,
  clampVolume,
};
