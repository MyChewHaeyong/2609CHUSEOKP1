// SOOP(숲) 비공식 채팅 소켓을 이용한 후원(별풍선) 자동 감지 커넥터.
// -----------------------------------------------------------------------------
// 로드맵 03절 확정 사항: "관리자 수동 +1 백업 버튼"이 주 안전망이고, 이 자동 감지는
// 되면 좋은 보조 수단입니다. 그래서 이 모듈은 철저히 "있으면 쓰고, 없거나 실패해도
// 나머지 서버 기능(특히 수동 버튼)은 절대 영향받지 않는다"를 원칙으로 짰습니다.
//
// - 비공식 npm 패키지 "soop-chat"(https://github.com/joyfuI/soop-chat)을 씁니다.
//   BJ 아이디만 있으면 로그인 없이 채팅 소켓에 연결할 수 있고, 별풍선 후원은
//   `sendBalloon`(일반 채널)/`sendBalloonSub`(서브 채널) 이벤트의 `data.count`로
//   내려옵니다(라이브러리 문서에 "observed" 근거 수준으로 명시됨 — 가장 신뢰도 높은 등급).
// - soop-chat은 ESM 전용 패키지라 이 서버(CommonJS)에서는 동적 import()로 불러옵니다.
// - SOOP이 프로토콜을 바꾸거나 연결이 끊기는 등 어떤 이유로든 예외가 나도 서버 전체가
//   죽지 않도록 모든 단계를 try/catch로 감쌌습니다. 실제 방송 전 리허설로 연결 상태를
//   미리 확인해보는 걸 강력히 권장합니다(관리자 화면에 연결 상태가 항상 표시됩니다).
"use strict";

// 연결 키(key) -> 연결 상태(메모리에만 유지). 복수 스트리머 협업 방송을 지원하기 위해,
// 방 코드 하나에 여러 참가자가 있을 수 있으므로 키를 "방코드:참가자ID"로 둡니다(참가자마다
// 자기 채널에만 연결). Railway가 재배포/재시작되면 연결이 끊기므로, 그럴 때는 관리자가
// 화면에서 다시 "연결" 버튼을 눌러야 합니다(수동 +1 버튼은 이 상태와 무관하게 항상 그대로
// 동작합니다).
const connectors = new Map();

function connectorKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function getStatus(roomCode, playerId) {
  const c = connectors.get(connectorKey(roomCode, playerId));
  if (!c) return { connected: false, state: "idle", streamerId: null, lastError: null, startedAt: null };
  return {
    connected: !!c.chat && c.chat.state === "connected",
    state: c.chat ? c.chat.state : "idle",
    streamerId: c.streamerId,
    lastError: c.lastError,
    startedAt: c.startedAt,
  };
}

// 방 코드 하나에 속한 모든 참가자의 연결 상태를 한 번에 조회합니다(관리자 화면에서
// 참가자별 SOOP 연결 상태를 나란히 보여줄 때 사용). { [playerId]: status } 형태로 반환.
function getStatusesForRoom(roomCode) {
  const prefix = `${roomCode}:`;
  const out = {};
  for (const key of connectors.keys()) {
    if (key.startsWith(prefix)) {
      const playerId = key.slice(prefix.length);
      out[playerId] = getStatus(roomCode, playerId);
    }
  }
  return out;
}

// onDonation(count): 별풍선 count개가 감지될 때마다 호출됩니다(호출부에서 addDonation로 연결).
// onLog(message): 연결 상태 변화나 오류를 문자열로 알려줍니다(서버 콘솔 로그용, 필수 아님).
async function start(roomCode, playerId, streamerId, onDonation, onLog) {
  await stop(roomCode, playerId); // 기존 연결이 있으면 정리하고 새로 시작

  const key = connectorKey(roomCode, playerId);
  const entry = { streamerId, chat: null, lastError: null, startedAt: Date.now() };
  connectors.set(key, entry);

  let SoopChatCtor;
  try {
    const mod = await import("soop-chat");
    SoopChatCtor = mod.SoopChat;
  } catch (e) {
    entry.lastError = "soop-chat 모듈을 불러오지 못했습니다: " + (e && e.message ? e.message : String(e));
    if (onLog) onLog(entry.lastError);
    // 엔트리는 지우지 않고 남겨둡니다 — 관리자 화면이 상태를 다시 조회했을 때 "idle"로
    // 초기화되지 않고 방금 실패한 이유(lastError)를 계속 보여줄 수 있어야 하기 때문입니다.
    throw new Error(entry.lastError);
  }

  let chat;
  try {
    chat = new SoopChatCtor({ streamerId });
  } catch (e) {
    entry.lastError = "SOOP 클라이언트 생성 실패: " + (e && e.message ? e.message : String(e));
    if (onLog) onLog(entry.lastError);
    throw new Error(entry.lastError);
  }
  entry.chat = chat;

  const handleBalloon = (event) => {
    try {
      const count = event && event.data ? event.data.count : null;
      if (Number.isFinite(count) && count > 0) {
        if (onLog) {
          const nick = (event.data && event.data.senderNickname) || "익명";
          onLog(`별풍선 ${count}개 감지 (${nick})`);
        }
        onDonation(count);
      }
    } catch (e) {
      entry.lastError = "별풍선 이벤트 처리 중 오류: " + (e && e.message ? e.message : String(e));
      if (onLog) onLog(entry.lastError);
    }
  };
  try {
    chat.on("sendBalloon", handleBalloon);
    chat.on("sendBalloonSub", handleBalloon);
    chat.on("error", (e) => {
      entry.lastError = (e && e.message) || String(e);
      if (onLog) onLog("SOOP 연결 오류: " + entry.lastError);
    });
    chat.on("ended", (e) => {
      entry.lastError = `연결 종료(사유: ${(e && e.reason) || "알 수 없음"})`;
      if (onLog) onLog("SOOP 연결 종료: " + entry.lastError);
    });
    chat.on("reconnecting", (e) => {
      if (onLog) onLog(`SOOP 재연결 시도 중 (${e.attempt}번째, ${e.delayMs}ms 후)`);
    });
  } catch (e) {
    entry.lastError = "이벤트 리스너 등록 실패: " + (e && e.message ? e.message : String(e));
    if (onLog) onLog(entry.lastError);
  }

  try {
    await chat.connect();
    if (onLog) onLog(`SOOP 채팅 연결 성공 (BJ: ${streamerId})`);
  } catch (e) {
    entry.lastError = (e && e.message) || String(e);
    if (onLog) onLog("SOOP 연결 실패: " + entry.lastError);
    throw e;
  }
  return getStatus(roomCode, playerId);
}

async function stop(roomCode, playerId) {
  const key = connectorKey(roomCode, playerId);
  const c = connectors.get(key);
  if (!c) return;
  connectors.delete(key);
  try {
    if (c.chat) await c.chat.disconnect();
  } catch (e) {
    // 종료 중 오류는 무시(이미 끊겼거나 연결에 실패한 상태일 수 있음)
  }
}

module.exports = { start, stop, getStatus, getStatusesForRoom };
