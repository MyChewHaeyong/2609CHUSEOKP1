// 팔도마블 - 1부 게임 서버
// 공통 엔진: 방 생성/입장, 상태 폴링, 행동(액션) 처리, 관리자 복구 도구
// 실시간성보다 안정성 우선: WebSocket 대신 클라이언트가 1초 간격으로 상태를 다시 불러오는 폴링 방식을 씁니다.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const Game = require("./game.js");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// DB 준비
// Railway에서는 코드가 재배포될 때 컨테이너 파일시스템이 초기화될 수 있어서,
// DB_PATH 환경변수(영구 저장공간에 마운트된 경로)가 있으면 그걸 쓰고, 없으면
// 로컬 개발용으로 프로젝트 폴더 안의 data.sqlite를 씁니다.
const dbPath = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  game_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  admin_key TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  name TEXT NOT NULL,
  seat INTEGER NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  player_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(room_code, request_id)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_code);
CREATE INDEX IF NOT EXISTS idx_snapshots_room ON snapshots(room_code, id);
`);

// 캐릭터 선택 기능 추가로 인한 마이그레이션: 이미 배포되어 있던 DB(예: Railway 볼륨)에는
// players 테이블에 character_id 컬럼이 없을 수 있으므로, 없을 때만 추가합니다.
const playerColumns = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
if (!playerColumns.includes("character_id")) {
  db.exec("ALTER TABLE players ADD COLUMN character_id INTEGER");
}

// ---------------------------------------------------------------------------
// 유틸리티
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0/O, 1/I 제외
function genRoomCode() {
  let code;
  const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?");
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)]).join("");
  } while (exists.get(code));
  return code;
}
function genKey(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}
function now() {
  return Date.now();
}

function getRoom(code) {
  return db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);
}
function getPlayers(code) {
  return db
    .prepare("SELECT id, name, seat, is_bot, character_id, last_seen FROM players WHERE room_code = ? ORDER BY seat ASC")
    .all(code);
}

// 캐릭터 4종 (참가자가 입장할 때 하나씩 고르고, BOT은 남은 것 중 무작위로 배정됨).
// 지금은 이미지 에셋 없이 이모지로 표시하되, 나중에 public/characters/char1.png ~ char4.png
// 파일을 저장소에 올리면 클라이언트가 자동으로 그 이미지를 우선 사용하도록 만들어 뒀습니다.
const CHARACTER_IDS = [1, 2, 3, 4];
function touchPlayer(playerId) {
  db.prepare("UPDATE players SET last_seen = ? WHERE id = ?").run(now(), playerId);
}
function saveSnapshot(roomCode, stateVersion, stateJson, label) {
  db.prepare(
    "INSERT INTO snapshots (room_code, state_version, state_json, label, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(roomCode, stateVersion, stateJson, label || null, now());
  // 최근 30개만 보관 (그 이전 것은 정리)
  const rows = db.prepare("SELECT id FROM snapshots WHERE room_code = ? ORDER BY id DESC").all(roomCode);
  if (rows.length > 30) {
    const toDelete = rows.slice(30).map((r) => r.id);
    const del = db.prepare("DELETE FROM snapshots WHERE id = ?");
    const tx = db.transaction((ids) => ids.forEach((id) => del.run(id)));
    tx(toDelete);
  }
}
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    seat: p.seat,
    isBot: !!p.is_bot,
    characterId: p.character_id || null,
    connected: now() - p.last_seen < 15000,
  };
}
function requireAdmin(req, res, room) {
  const key = req.body?.adminKey || req.query.adminKey;
  if (!key || key !== room.admin_key) {
    res.status(403).json({ ok: false, error: "관리자 키가 올바르지 않습니다." });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 방 생성 / 입장
app.post("/api/rooms", (req, res) => {
  const gameMode = req.body?.gameMode === "auction" ? "auction" : "paldomarble";
  const code = genRoomCode();
  const adminKey = genKey();
  const ts = now();
  const state = { phase: "waiting" };
  db.prepare(
    "INSERT INTO rooms (code, game_mode, status, admin_key, state_version, state_json, created_at, updated_at) VALUES (?, ?, 'waiting', ?, 0, ?, ?, ?)"
  ).run(code, gameMode, adminKey, JSON.stringify(state), ts, ts);
  saveSnapshot(code, 0, JSON.stringify(state), "방 생성");
  res.json({ ok: true, roomCode: code, adminKey, gameMode });
});

app.post("/api/rooms/:code/join", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  const name = (req.body?.name || "").trim().slice(0, 20);
  if (!name) return res.status(400).json({ ok: false, error: "이름을 입력해주세요." });

  const characterId = Number(req.body?.characterId);
  if (!CHARACTER_IDS.includes(characterId)) {
    return res.status(400).json({ ok: false, error: "캐릭터를 선택해주세요." });
  }
  const takenIds = db
    .prepare("SELECT character_id FROM players WHERE room_code = ? AND character_id IS NOT NULL")
    .all(room.code)
    .map((r) => r.character_id);
  if (takenIds.length >= CHARACTER_IDS.length) {
    return res.status(400).json({ ok: false, error: "이미 모든 캐릭터가 선택되어 더 참가할 수 없습니다." });
  }
  if (takenIds.includes(characterId)) {
    return res.status(400).json({ ok: false, error: "다른 참가자가 이미 선택한 캐릭터입니다. 다른 캐릭터를 골라주세요." });
  }

  const seatRow = db.prepare("SELECT COALESCE(MAX(seat), -1) AS m FROM players WHERE room_code = ?").get(room.code);
  const seat = seatRow.m + 1;
  const playerId = crypto.randomUUID();
  const token = genKey();
  db.prepare(
    "INSERT INTO players (id, room_code, name, seat, is_bot, character_id, token, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?, ?)"
  ).run(playerId, room.code, name, seat, characterId, token, now());

  res.json({ ok: true, playerId, token, seat, characterId, roomCode: room.code, gameMode: room.game_mode });
});

// ---------------------------------------------------------------------------
// 상태 폴링 (Player / Broadcast 공용, 1초 간격 호출을 전제로 함)
app.get("/api/rooms/:code/state", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });

  const { playerId, token } = req.query;
  if (playerId && token) {
    const p = db.prepare("SELECT * FROM players WHERE id = ? AND room_code = ?").get(playerId, room.code);
    if (p && p.token === token) touchPlayer(playerId);
  }

  res.json({
    ok: true,
    roomCode: room.code,
    gameMode: room.game_mode,
    status: room.status,
    stateVersion: room.state_version,
    state: JSON.parse(room.state_json),
    players: getPlayers(room.code).map(publicPlayer),
    serverTime: now(),
  });
});

// ---------------------------------------------------------------------------
// 행동(액션) 처리 — 요청 ID 기반 중복 방지. 실제 게임 로직(주사위/구매 등)은
// 다음 단계에서 이 안의 switch(type)에 채워 넣습니다.
app.post("/api/rooms/:code/action", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });

  const { requestId, playerId, token, type, payload } = req.body || {};
  if (!requestId || !playerId || !token || !type) {
    return res.status(400).json({ ok: false, error: "요청에 필요한 값이 빠졌습니다." });
  }
  const player = db.prepare("SELECT * FROM players WHERE id = ? AND room_code = ?").get(playerId, room.code);
  if (!player || player.token !== token) {
    return res.status(403).json({ ok: false, error: "플레이어 인증에 실패했습니다." });
  }

  // 이미 처리된 요청이면 그때 결과를 그대로 다시 돌려줌 (더블클릭/재전송 방지)
  const prior = db.prepare("SELECT * FROM action_log WHERE room_code = ? AND request_id = ?").get(room.code, requestId);
  if (prior) {
    return res.json({ ok: true, deduped: true, ...JSON.parse(prior.result_json) });
  }

  touchPlayer(playerId);
  let result;
  try {
    result = applyAction(room, player, type, payload || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "행동 처리 중 오류가 발생했습니다." });
  }

  db.prepare(
    "INSERT INTO action_log (room_code, request_id, player_id, type, payload_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(room.code, requestId, playerId, type, JSON.stringify(payload || {}), JSON.stringify(result), now());

  res.json({ ok: true, deduped: false, ...result });
});

// 액션 처리기. "ping"은 공통 엔진 동기화 테스트용으로 그대로 유지하고,
// 나머지 타입은 팔도마블 게임 로직(game.js)으로 넘깁니다.
// 실패 시 여기서 Error를 던지면 위 라우트에서 잡아 400으로 깔끔하게 응답합니다.
function applyAction(room, player, type, payload) {
  const state = JSON.parse(room.state_json);
  let stateChanged = false;
  let newStatus = room.status;

  if (type === "ping") {
    state.lastPing = { by: player.name, at: now() };
    stateChanged = true;
  } else if (room.game_mode === "paldomarble") {
    if (state.phase === "waiting" || !state.phase) {
      throw new Error("게임이 아직 시작되지 않았습니다. 관리자가 먼저 게임을 시작해야 합니다.");
    }
    if (state.phase === "ended") {
      throw new Error("게임이 이미 종료되었습니다.");
    }
    Game.applyPlayerAction(state, player.id, type, payload, now());
    stateChanged = true;
    newStatus = state.phase === "ended" ? "ended" : "playing";
  } else {
    throw new Error("알 수 없는 행동입니다: " + type);
  }

  if (stateChanged) {
    const newVersion = room.state_version + 1;
    const stateJson = JSON.stringify(state);
    db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, status = ?, updated_at = ? WHERE code = ?").run(
      stateJson,
      newVersion,
      newStatus,
      now(),
      room.code
    );
    saveSnapshot(room.code, newVersion, stateJson, `action:${type}`);
    return { stateVersion: newVersion, state };
  }
  return { stateVersion: room.state_version, state };
}

// ---------------------------------------------------------------------------
// 관리자 도구: 상태 확인, 스냅샷/되돌리기, 비상 대리 입력, JSON 백업/복원
app.get("/api/rooms/:code/admin", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;

  const recentActions = db
    .prepare("SELECT type, player_id, created_at FROM action_log WHERE room_code = ? ORDER BY id DESC LIMIT 20")
    .all(room.code);
  res.json({
    ok: true,
    room: {
      code: room.code,
      gameMode: room.game_mode,
      status: room.status,
      stateVersion: room.state_version,
      state: JSON.parse(room.state_json),
    },
    players: getPlayers(room.code).map(publicPlayer),
    recentActions,
  });
});

// 게임 시작: 관리자가 (필요시) 전체 인원수를 정하면, 남은 자리를 BOT으로 채우고
// 팔도마블 게임 상태를 초기화합니다. 사람 참가자는 이미 참가한 순서대로 좌석을 유지합니다.
const BOT_NAME_POOL = ["옆집아저씨봇", "떡방앗간봇", "송편요정봇", "한가위봇"];
app.post("/api/rooms/:code/admin/start-game", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "paldomarble") {
    return res.status(400).json({ ok: false, error: "이 방은 팔도마블 방이 아닙니다." });
  }

  const state = JSON.parse(room.state_json);
  if (state.phase === "playing" || state.phase === "ended") {
    return res.status(400).json({ ok: false, error: "이미 게임이 시작되었습니다." });
  }

  let totalPlayers = Number(req.body?.totalPlayers) || 4;
  totalPlayers = Math.max(2, Math.min(4, totalPlayers));

  const humanPlayers = db
    .prepare("SELECT * FROM players WHERE room_code = ? AND is_bot = 0 ORDER BY seat ASC")
    .all(room.code);
  if (humanPlayers.length < 1) {
    return res.status(400).json({ ok: false, error: "참가자가 최소 1명 이상 있어야 게임을 시작할 수 있습니다." });
  }
  if (humanPlayers.length > totalPlayers) {
    return res.status(400).json({
      ok: false,
      error: `참가 인원(${humanPlayers.length}명)이 설정한 전체 인원수(${totalPlayers}명)보다 많습니다.`,
    });
  }

  let nextSeat = db.prepare("SELECT COALESCE(MAX(seat), -1) AS m FROM players WHERE room_code = ?").get(room.code).m + 1;
  const botsNeeded = totalPlayers - humanPlayers.length;
  // 방장이 BOT 이름을 직접 입력했으면 그 이름을 쓰고(빈 칸/중복이면 기본 이름으로 대체),
  // 안 보냈으면 기존처럼 기본 이름 목록을 순서대로 씁니다.
  const requestedNames = Array.isArray(req.body?.botNames) ? req.body.botNames : [];
  const usedNames = new Set(humanPlayers.map((p) => p.name));
  // 사람이 고르고 남은 캐릭터를 무작위 순서로 섞어서 BOT들에게 하나씩 배정합니다.
  // (전체 인원이 최대 4명이고 캐릭터도 정확히 4종이라 항상 충분히 남습니다.)
  const takenCharIds = new Set(humanPlayers.map((p) => p.character_id).filter((id) => id != null));
  const remainingCharIds = CHARACTER_IDS.filter((id) => !takenCharIds.has(id));
  for (let i = remainingCharIds.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [remainingCharIds[i], remainingCharIds[j]] = [remainingCharIds[j], remainingCharIds[i]];
  }

  const insertPlayer = db.prepare(
    "INSERT INTO players (id, room_code, name, seat, is_bot, character_id, token, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?, ?)"
  );
  for (let i = 0; i < botsNeeded; i++) {
    let botName = String(requestedNames[i] || "").trim().slice(0, 20);
    if (!botName || usedNames.has(botName)) {
      botName = BOT_NAME_POOL[i % BOT_NAME_POOL.length] + (i >= BOT_NAME_POOL.length ? `${i + 1}` : "");
    }
    usedNames.add(botName);
    const botCharId = remainingCharIds[i] != null ? remainingCharIds[i] : null;
    insertPlayer.run(crypto.randomUUID(), room.code, botName, nextSeat, botCharId, genKey(), now());
    nextSeat++;
  }

  const allPlayers = db.prepare("SELECT * FROM players WHERE room_code = ? ORDER BY seat ASC").all(room.code);
  const gameState = Game.initState(
    allPlayers.map((p) => ({ id: p.id, name: p.name, seat: p.seat, isBot: !!p.is_bot, characterId: p.character_id || null }))
  );
  Game.runBotsIfNeeded(gameState, now());

  const newVersion = room.state_version + 1;
  const stateJson = JSON.stringify(gameState);
  db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, status = 'playing', updated_at = ? WHERE code = ?").run(
    stateJson,
    newVersion,
    now(),
    room.code
  );
  saveSnapshot(room.code, newVersion, stateJson, "게임 시작");

  res.json({ ok: true, stateVersion: newVersion, state: gameState, players: getPlayers(room.code).map(publicPlayer) });
});

// 비상 강제 종료: 방송 시간이 다 되어 "최후 1인 생존"을 기다릴 수 없을 때, 지금 이 순간의
// 자산(현금+토지+건물 평가액) 기준으로 순위를 확정하고 게임을 끝냅니다. (규칙서 "결산 코드" 절 기준)
app.post("/api/rooms/:code/admin/force-end", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "paldomarble") {
    return res.status(400).json({ ok: false, error: "이 방은 팔도마블 방이 아닙니다." });
  }

  const state = JSON.parse(room.state_json);
  try {
    Game.forceEndGame(state);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "종료 처리 중 오류가 발생했습니다." });
  }

  const newVersion = room.state_version + 1;
  const stateJson = JSON.stringify(state);
  db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, status = 'ended', updated_at = ? WHERE code = ?").run(
    stateJson,
    newVersion,
    now(),
    room.code
  );
  saveSnapshot(room.code, newVersion, stateJson, "관리자 강제 종료");

  res.json({ ok: true, stateVersion: newVersion, state });
});

app.post("/api/rooms/:code/admin/undo", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;

  // 가장 최근 스냅샷(현재 상태와 같을 수 있음)은 건너뛰고, 그 이전 스냅샷으로 되돌림
  const rows = db.prepare("SELECT * FROM snapshots WHERE room_code = ? ORDER BY id DESC LIMIT 2").all(room.code);
  const target = rows[1] || rows[0];
  if (!target) return res.status(400).json({ ok: false, error: "되돌릴 이전 상태가 없습니다." });

  db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, updated_at = ? WHERE code = ?").run(
    target.state_json,
    target.state_version,
    now(),
    room.code
  );
  if (rows[0]) db.prepare("DELETE FROM snapshots WHERE id = ?").run(rows[0].id);

  res.json({ ok: true, stateVersion: target.state_version, state: JSON.parse(target.state_json) });
});

app.post("/api/rooms/:code/admin/emergency-action", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;

  const { asPlayerId, type, payload } = req.body || {};
  const player = db.prepare("SELECT * FROM players WHERE id = ? AND room_code = ?").get(asPlayerId, room.code);
  if (!player) return res.status(404).json({ ok: false, error: "대상 플레이어를 찾을 수 없습니다." });

  let result;
  try {
    result = applyAction(room, player, type, payload || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "행동 처리 중 오류가 발생했습니다." });
  }
  db.prepare(
    "INSERT INTO action_log (room_code, request_id, player_id, type, payload_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(room.code, "admin-" + genKey(6), player.id, type, JSON.stringify(payload || {}), JSON.stringify(result), now());

  res.json({ ok: true, ...result });
});

app.get("/api/rooms/:code/admin/export", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;

  res.json({
    ok: true,
    exportedAt: now(),
    room,
    players: db.prepare("SELECT * FROM players WHERE room_code = ?").all(room.code),
  });
});

app.post("/api/rooms/:code/admin/import", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;

  const data = req.body?.data;
  if (!data?.room) return res.status(400).json({ ok: false, error: "가져올 데이터 형식이 올바르지 않습니다." });

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE rooms SET game_mode=?, status=?, state_version=?, state_json=?, updated_at=? WHERE code=?"
    ).run(data.room.game_mode, data.room.status, data.room.state_version, data.room.state_json, now(), room.code);
    db.prepare("DELETE FROM players WHERE room_code = ?").run(room.code);
    const ins = db.prepare(
      "INSERT INTO players (id, room_code, name, seat, is_bot, token, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    (data.players || []).forEach((p) => ins.run(p.id, room.code, p.name, p.seat, p.is_bot, p.token, p.last_seen));
  });
  tx();
  saveSnapshot(room.code, data.room.state_version, data.room.state_json, "관리자 복원");

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, part: 1, name: "팔도마블", ts: Date.now() });
});
app.get("/api/status", (req, res) => {
  res.json({ status: "공통 엔진 + 팔도마블 게임 로직 구현 완료 (테스트 중)", updated: "2026-09-08" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[part1] listening on ${PORT} (db: ${dbPath})`);
});
