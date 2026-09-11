// 후원 효과 시스템 (1부 팔도마블 · 2부 만찬경매 공통 로직)
// -----------------------------------------------------------------------------
// 방송 중 들어오는 "한 번의 후원"이 정확히 30개/31개, 300개/301개짜리일 때마다(한 번의
// 후원 이벤트 크기 기준 — 누적 총합이 그 숫자를 지나칠 때가 아님) 가격 보정 효과가
// 발동합니다. 같은 방송에서 정확히 그 개수짜리 후원이 여러 번 들어오면 그때마다 매번 다시
// 발동합니다(반복 가능, 1회성 아님). 효과는 누적되며(최대 ±50%), 이후 모든 가격 계산에
// 계속 적용됩니다.
//
// 예) 후원 30개(누적 30개) → 발동(+1~5% 중 무작위) / 후원 20개(누적 50개) → 미발동(20은
//     기준이 아님) / 후원 31개(누적 81개) → 발동(-1~5% 중 무작위) / 후원 300개(누적 381개)
//     → 발동(+5~10% 중 무작위) / 후원 100개(누적 481개) → 미발동 / 후원 301개(누적 782개)
//     → 발동(-5~10% 중 무작위). (사용자 확정 사항, 2026-09-11 / 부호 고정 수정 2026-09-11)
//
// 1부·2부는 완전히 독립적으로 이 상태를 하나씩 따로 들고 있습니다(로드맵 확정 사항:
// "파트별 독립" — 후원 카운트/누적 보정률을 1부와 2부가 공유하지 않음). 각 게임의
// state 안에 { donationEffect: createState() } 형태로 보관하고, game.js/game2.js가
// 이 모듈의 순수 함수만 불러다 씁니다. DB/HTTP/SOOP 채팅 연결은 server.js가 담당합니다.
"use strict";

// 트리거 표(사용자 확정 사항, 2026-09-11 — "한 번의 후원 크기"가 정확히 이 숫자일 때만
// 발동. 부호는 더 이상 무작위가 아니라 후원 개수로 고정됩니다 — 2026-09-11 수정):
//   후원 30개  -> +1.0%~+5.0%, 0.5%씩 9단계 중 무작위 (항상 긍정)
//   후원 31개  -> -1.0%~-5.0%, 0.5%씩 9단계 중 무작위 (항상 부정)
//   후원 300개 -> +5.0%~+10.0%, 0.5%씩 11단계 중 무작위 (항상 긍정)
//   후원 301개 -> -5.0%~-10.0%, 0.5%씩 11단계 중 무작위 (항상 부정)
// addDonations()에 들어오는 n(이번 한 번의 후원 개수)을 직접 검사합니다. 여러 번의
// 서로 다른 후원을 합친 누적치가 우연히 이 숫자를 지나가는 것은 발동 대상이 아닙니다.
// 누적 보정률 처리 방식(누적, 최대 ±50% 상한, on/off 토글 등)은 그대로 유지됩니다.
const TRIGGERS = [
  { count: 30, sign: 1, minPct: 1.0, maxPct: 5.0, stepPct: 0.5 },
  { count: 31, sign: -1, minPct: 1.0, maxPct: 5.0, stepPct: 0.5 },
  { count: 300, sign: 1, minPct: 5.0, maxPct: 10.0, stepPct: 0.5 },
  { count: 301, sign: -1, minPct: 5.0, maxPct: 10.0, stepPct: 0.5 },
];
const CAP = 0.5; // 누적 보정률 상한 ±50%

function triggerForCount(count) {
  return TRIGGERS.find((t) => t.count === count) || null;
}

// 트리거 하나의 가능한 퍼센트 단계 배열(부호 없이) — 예: 1.0, 1.5, 2.0, ..., 5.0
function stepsFor(trigger) {
  const steps = [];
  const n = Math.round((trigger.maxPct - trigger.minPct) / trigger.stepPct) + 1;
  for (let i = 0; i < n; i++) {
    steps.push(Math.round((trigger.minPct + i * trigger.stepPct) * 10) / 10);
  }
  return steps;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function createState() {
  return {
    count: 0, // 누적 후원 개수(이 파트에서만 집계 — 발동 여부와 무관하게 항상 더해짐)
    cumulativeRate: 0, // 누적 가격 보정률. 양수 = 플레이어에게 유리(지출↓ 수입↑), 음수 = 불리
    history: [], // [{ donationSize, atCount, deltaPct, before, after, source, appliedAt }]
    log: [], // 관리자 화면 표시용 텍스트 로그(최근 것 위주)
  };
}

// 이전 버전에서 저장된 방(구버전 백업 JSON 복원 등)이나, donationEffect 필드가 아직
// 없는 state를 다뤄도 죽지 않도록 안전하게 상태를 얻는 헬퍼.
function ensureState(state) {
  if (!state.donationEffect) state.donationEffect = createState();
  return state.donationEffect;
}

function rateOf(state) {
  return (state.donationEffect && state.donationEffect.cumulativeRate) || 0;
}

// 후원 n건을 "한 번의 후원 이벤트"로 추가합니다(수동 입력창은 입력한 값 그대로, SOOP
// 자동 감지는 실제 후원 메시지 하나의 별풍선 개수를 그대로 전달하면 됩니다). 이번에 들어온
// n이 정확히 30/31/300/301이면 그 즉시 보정 효과가 발동합니다(누적 총합이 그 숫자를
// "지나칠" 때가 아니라, 한 번의 후원 크기 자체가 그 숫자일 때만 — 사용자 확정 사항). 같은
// 크기의 후원이 방송 중 여러 번 들어오면 그때마다 매번 다시 발동합니다(1회성 제한 없음).
// 부호는 후원 개수로 고정되고(30/300 -> 항상 긍정, 31/301 -> 항상 부정), 그 범위 안에서
// 퍼센트 크기만 무작위로 정해집니다. source는 로그 표시용 문자열("관리자 수동" |
// "SOOP 자동감지")입니다.
function addDonations(state, n, now, source) {
  const de = ensureState(state);
  n = Math.max(1, Math.floor(Number(n) || 1));
  de.count += n;
  const fired = [];
  const trigger = triggerForCount(n);
  if (trigger) {
    const steps = stepsFor(trigger);
    const pct = steps[Math.floor(Math.random() * steps.length)];
    const deltaPct = trigger.sign * pct;
    const before = de.cumulativeRate;
    de.cumulativeRate = clamp(de.cumulativeRate + deltaPct / 100, -CAP, CAP);
    const entry = {
      donationSize: n, // 이번에 발동을 일으킨 후원 건의 크기(30/31/300/301 중 하나)
      atCount: de.count, // 참고용: 이 발동이 일어난 시점의 누적 후원 개수
      deltaPct,
      before,
      after: de.cumulativeRate,
      source: source || "관리자 수동",
      appliedAt: now || Date.now(),
    };
    de.history.push(entry);
    fired.push(entry);
    de.log.push(
      `[후원 효과] 후원 ${n}개 도착 — ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% 발동` +
        ` (누적 보정률 ${(before * 100).toFixed(1)}% → ${(de.cumulativeRate * 100).toFixed(1)}%, 누적 후원 ${de.count}개)`
    );
  }
  if (de.log.length > 50) de.log = de.log.slice(-50);
  return fired; // 이번 호출로 새로 발동한 효과 목록(발동 안 했으면 빈 배열, 발동했으면 항목 1개)
}

// 지출(플레이어가 내는 돈: 구매가·통행료·건설비·낙찰가 등) — 긍정 보정률이면 싸지고,
// 부정 보정률이면 비싸집니다. amount가 0 이하면 그대로 돌려줍니다(마이너스 방지는
// 호출부에서 필요시 별도 처리).
function applyExpenditureRate(amount, rate) {
  if (!amount || amount <= 0) return amount;
  return Math.max(0, Math.round(amount * (1 - rate)));
}

// 수입/평가액(플레이어가 받는 돈이나 자산 평가: 매각환급금·통행료 수취·최종 자산가치 등)
// — 긍정 보정률이면 늘고, 부정 보정률이면 줄어듭니다.
function applyIncomeRate(amount, rate) {
  if (!amount || amount <= 0) return amount;
  return Math.max(0, Math.round(amount * (1 + rate)));
}

// 관리자 화면 등 외부에 보여줄 요약.
function summarize(state) {
  const de = ensureState(state);
  return {
    count: de.count,
    cumulativeRate: de.cumulativeRate,
    cumulativeRatePct: Math.round(de.cumulativeRate * 1000) / 10, // 소수 첫째자리 %
    history: de.history.slice(-20),
    log: de.log.slice(-20),
  };
}

module.exports = {
  TRIGGERS,
  CAP,
  createState,
  ensureState,
  rateOf,
  addDonations,
  applyExpenditureRate,
  applyIncomeRate,
  summarize,
  triggerForCount,
  stepsFor,
};
