// 후원 효과 시스템 (1부 팔도마블 · 2부 만찬경매 공통 로직)
// -----------------------------------------------------------------------------
// 방송 중 들어오는 후원(별풍선 등)의 "누적 개수"가 정확히 30개/31개, 300개/301개에
// 도달하는 순간마다 무작위 가격 보정 효과가 한 번씩 발동합니다. 효과는 누적되며
// (최대 ±50%), 이후 모든 가격 계산에 계속 적용됩니다.
//
// 1부·2부는 완전히 독립적으로 이 상태를 하나씩 따로 들고 있습니다(로드맵 확정 사항:
// "파트별 독립" — 후원 카운트/누적 보정률을 1부와 2부가 공유하지 않음). 각 게임의
// state 안에 { donationEffect: createState() } 형태로 보관하고, game.js/game2.js가
// 이 모듈의 순수 함수만 불러다 씁니다. DB/HTTP/SOOP 채팅 연결은 server.js가 담당합니다.
"use strict";

// 트리거 표(로드맵 03절 "설계 확정" 기준, 그대로 구현):
//   후원 30개/31개  -> ±1.0%~5.0%, 0.5%씩 9단계
//   후원 300개/301개 -> ±5.0%~10.0%, 0.5%씩 11단계
// 각 트리거는 "정확히 그 개수에 도달하는 순간" 딱 한 번만 발동합니다.
const TRIGGERS = [
  { counts: [30, 31], minPct: 1.0, maxPct: 5.0, stepPct: 0.5 },
  { counts: [300, 301], minPct: 5.0, maxPct: 10.0, stepPct: 0.5 },
];
const CAP = 0.5; // 누적 보정률 상한 ±50%

function triggerForCount(count) {
  return TRIGGERS.find((t) => t.counts.includes(count)) || null;
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
    count: 0, // 누적 후원 개수(이 파트에서만 집계)
    cumulativeRate: 0, // 누적 가격 보정률. 양수 = 플레이어에게 유리(지출↓ 수입↑), 음수 = 불리
    firedCounts: [], // 이미 발동한 count 값 기록(정확히 한 번씩만 발동시키기 위함)
    history: [], // [{ atCount, deltaPct, before, after, source, appliedAt }]
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

// 후원 n건을 추가합니다(수동 "+1" 버튼은 n=1, SOOP 자동 감지의 별풍선 count도 그대로
// 전달하면 됩니다). 정확히 30/31/300/301에 도달하는 순간마다(한 번씩만) 무작위 보정
// 효과를 발동시키며, 한 번의 호출로 여러 트리거를 동시에 지나칠 수도 있으므로(예:
// 한 번에 5개 후원이 들어와 29 -> 34가 되는 경우) 반드시 1개씩 증가시키며 확인합니다.
// source는 로그 표시용 문자열("관리자 수동" | "SOOP 자동감지")입니다.
function addDonations(state, n, now, source) {
  const de = ensureState(state);
  n = Math.max(1, Math.floor(Number(n) || 1));
  const fired = [];
  for (let i = 0; i < n; i++) {
    de.count += 1;
    const trigger = triggerForCount(de.count);
    if (trigger && !de.firedCounts.includes(de.count)) {
      de.firedCounts.push(de.count);
      const steps = stepsFor(trigger);
      const pct = steps[Math.floor(Math.random() * steps.length)];
      const sign = Math.random() < 0.5 ? 1 : -1;
      const deltaPct = sign * pct;
      const before = de.cumulativeRate;
      de.cumulativeRate = clamp(de.cumulativeRate + deltaPct / 100, -CAP, CAP);
      const entry = {
        atCount: de.count,
        deltaPct,
        before,
        after: de.cumulativeRate,
        source: source || "관리자 수동",
        appliedAt: now || Date.now(),
      };
      de.history.push(entry);
      fired.push(entry);
      de.log.push(
        `[후원 효과] 누적 ${de.count}개 도달 — ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% 발동` +
          ` (누적 보정률 ${(before * 100).toFixed(1)}% → ${(de.cumulativeRate * 100).toFixed(1)}%)`
      );
    }
  }
  if (de.log.length > 50) de.log = de.log.slice(-50);
  return fired; // 이번 호출로 새로 발동한 효과 목록(0개일 수도, 여러 개일 수도 있음)
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

// 관리자 화면 등 외부에 보여줄 요약(내부 firedCounts 배열 같은 건 굳이 노출할 필요 없음).
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
