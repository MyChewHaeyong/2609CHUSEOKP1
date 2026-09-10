// 팔도마블 - 1부 게임 서버
// 공통 엔진: 방 생성/입장, 상태 폴링, 행동(액션) 처리, 관리자 복구 도구
// 실시간성보다 안정성 우선: WebSocket 대신 클라이언트가 1초 간격으로 상태를 다시 불러오는 폴링 방식을 씁니다.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const Game = require("./game.js");
const Game2 = require("./game2.js"); // 2부 만찬경매

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
// 2부(만찬경매) state.phase를 rooms.status 컬럼(waiting/playing/ended)으로 매핑.
// 1부의 undo 버그 수정 때와 같은 이유로, 상태를 저장할 때마다 항상 이 매핑을 같이 갱신해야
// join 가능 여부(waiting 체크) 등이 화면과 어긋나지 않습니다.
function auctionStatusFor(phase) {
  if (phase === "ended") return "ended";
  if (!phase || phase === "waiting") return "waiting";
  return "playing"; // bidding / table-review / voting
}
function persistState(room, state, label, status) {
  const newVersion = room.state_version + 1;
  const stateJson = JSON.stringify(state);
  db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, status = ?, updated_at = ? WHERE code = ?").run(
    stateJson,
    newVersion,
    status,
    now(),
    room.code
  );
  saveSnapshot(room.code, newVersion, stateJson, label);
  return newVersion;
}

// 1부 결과로 2부 시드머니 자동 연결: 1부 방 코드를 넘기면, 그 방의 최종 등수(finalRanking)에서
// 사람 참가자를 "이름"으로 매칭해 2부 등수(ranks)와 타이브레이커용 자산액(part1Assets)을
// 자동으로 만들어 줍니다. 두 방이 서로 다른 방이라 playerId가 다르기 때문에 이름 매칭을
// 쓰고, 이름이 안 맞아 매칭에 실패한 사람은 unmatched로 보고해서 관리자가 필요하면 수동
// ranks로 보정할 수 있게 합니다(1부에서 이미 사람인지 BOT인지 구분되므로 BOT은 매칭 대상에서
// 제외합니다).
function deriveRanksFromPart1(part1Room, currentHumanPlayers) {
  const result = { ranks: {}, part1Assets: {}, matched: [], unmatched: [] };
  if (!part1Room) {
    currentHumanPlayers.forEach((p) => result.unmatched.push(p.name));
    return result;
  }
  const part1State = JSON.parse(part1Room.state_json);
  const finalRanking = part1State.finalRanking || [];
  const byName = new Map();
  finalRanking.forEach((r) => {
    const isBot = !!part1State.players?.[r.playerId]?.isBot;
    if (!isBot && !byName.has(r.name)) byName.set(r.name, r);
  });

  currentHumanPlayers.forEach((p) => {
    const r = byName.get(p.name);
    if (r) {
      result.ranks[p.id] = r.rank;
      result.part1Assets[p.id] = r.netWorth;
      result.matched.push({ playerId: p.id, name: p.name, rank: r.rank, netWorth: r.netWorth });
    } else {
      result.unmatched.push(p.name);
    }
  });
  return result;
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
  if (room.status !== "waiting") {
    return res.status(400).json({ ok: false, error: "이미 게임이 시작되어 더 이상 입장할 수 없습니다." });
  }
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

  // 2부(만찬경매)는 실시간 타이머(품목당 5분, 투표 5분)가 있어서, 클라이언트가 폴링할 때마다
  // 마감 시간이 지났는지 확인해 필요하면 여기서 즉시 처리합니다(별도 스케줄러 없이, 1부의
  // 90분 통행료 인상 타이머와 같은 "읽을 때 계산" 방식). adminKey가 맞으면 관리자 전용 정보
  // (투표 중 실시간 득표수)도 함께 내려줍니다.
  if (room.game_mode === "auction") {
    const state = JSON.parse(room.state_json);
    const changed = Game2.tick(state, now());
    let stateVersion = room.state_version;
    if (changed) {
      stateVersion = persistState(room, state, "자동 진행(타이머)", auctionStatusFor(state.phase));
    }
    const isAdmin = !!(req.query.adminKey && req.query.adminKey === room.admin_key);
    return res.json({
      ok: true,
      roomCode: room.code,
      gameMode: room.game_mode,
      status: auctionStatusFor(state.phase),
      stateVersion,
      state: Game2.serializeForClient(state, { forAdmin: isAdmin }),
      players: getPlayers(room.code).map(publicPlayer),
      serverTime: now(),
    });
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
  } else if (room.game_mode === "auction") {
    // 폴링과 마찬가지로, 입찰을 처리하기 전에 먼저 마감 시간이 지나지 않았는지 확인합니다
    // (거의 동시에 타이머가 끝난 경우 "이미 끝난 라운드에 입찰"을 막기 위함).
    Game2.tick(state, now());
    if (type === "bid") {
      Game2.placeBid(state, player.id, payload?.amount, now());
    } else {
      throw new Error("알 수 없는 행동입니다: " + type);
    }
    stateChanged = true;
    newStatus = auctionStatusFor(state.phase);
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
    // 2부는 서버 내부 상태(경매 순서 등 비밀 정보)를 그대로 돌려주면 안 되므로, 응답에는
    // 항상 마스킹된 클라이언트용 상태만 담습니다.
    const responseState = room.game_mode === "auction" ? Game2.serializeForClient(state, { forAdmin: false }) : state;
    return { stateVersion: newVersion, state: responseState };
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

// ---------------------------------------------------------------------------
// 2부 만찬경매 — 1부와 같은 방/입장/캐릭터 선택 엔진을 그대로 재사용하고,
// 게임 로직만 game2.js로 분리했습니다.

// 2부 경매 시작: 1부와 동일하게 부족한 자리는 BOT으로 채우고, 각 사람 참가자에게 1부 등수
// (ranks)에 맞는 시드머니를 지급한 뒤 14개 품목 블라인드 경매를 시작합니다. ranks/part1Assets는
// 1부와 2부가 서로 다른 방이라 시스템이 자동으로 이어줄 방법이 없어 관리자가 직접 넘겨줍니다
// (2부 규칙서: 등수 정보가 없으면 전원 2등 시드머니를 기본값으로 씀).
// 2부 경매를 실제로 시작하기 전에, 1부 방 코드로 등수 매칭이 잘 되는지 미리 확인할 수 있는
// 조회 전용 엔드포인트입니다(상태를 바꾸지 않음). 이름이 하나라도 안 맞으면 여기서 미리 보고
// admin/start-auction 호출 시 ranks/part1Assets로 수동 보정해서 넘길 수 있습니다.
app.get("/api/rooms/:code/admin/part1-preview", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "auction") {
    return res.status(400).json({ ok: false, error: "이 방은 만찬경매 방이 아닙니다." });
  }
  const part1RoomCode = String(req.query.part1RoomCode || "").toUpperCase();
  const part1Room = getRoom(part1RoomCode);
  if (!part1Room || part1Room.game_mode !== "paldomarble") {
    return res.status(400).json({ ok: false, error: "1부 방 코드가 올바르지 않습니다." });
  }
  const part1State = JSON.parse(part1Room.state_json);
  if (part1State.phase !== "ended") {
    return res.status(400).json({ ok: false, error: "1부 게임이 아직 끝나지 않아 등수가 확정되지 않았습니다." });
  }
  const humanPlayers = db
    .prepare("SELECT * FROM players WHERE room_code = ? AND is_bot = 0 ORDER BY seat ASC")
    .all(room.code);
  const match = deriveRanksFromPart1(
    part1Room,
    humanPlayers.map((p) => ({ id: p.id, name: p.name }))
  );
  res.json({ ok: true, ...match });
});

app.post("/api/rooms/:code/admin/start-auction", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "auction") {
    return res.status(400).json({ ok: false, error: "이 방은 만찬경매 방이 아닙니다." });
  }
  const existing = JSON.parse(room.state_json);
  if (existing.phase && existing.phase !== "waiting") {
    return res.status(400).json({ ok: false, error: "이미 경매가 시작되었습니다." });
  }

  let totalPlayers = Number(req.body?.totalPlayers) || 4;
  totalPlayers = Math.max(1, Math.min(4, totalPlayers));

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
  const requestedNames = Array.isArray(req.body?.botNames) ? req.body.botNames : [];
  const usedNames = new Set(humanPlayers.map((p) => p.name));
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
  let ranks = req.body?.ranks && typeof req.body.ranks === "object" ? req.body.ranks : {};
  let part1Assets = req.body?.part1Assets && typeof req.body.part1Assets === "object" ? req.body.part1Assets : {};

  // fromPart1RoomCode를 넘기면 그 1부 방의 최종 등수를 이름으로 매칭해서 자동으로 ranks/
  // part1Assets를 채웁니다. 요청에 ranks/part1Assets를 같이 넘기면(이름이 하나라도 안 맞았을
  // 때 수동 보정용) 그 값이 자동 매칭 결과보다 우선합니다.
  let part1Match = null;
  if (req.body?.fromPart1RoomCode) {
    const part1Room = getRoom(String(req.body.fromPart1RoomCode).toUpperCase());
    if (!part1Room || part1Room.game_mode !== "paldomarble") {
      return res.status(400).json({ ok: false, error: "1부 방 코드가 올바르지 않습니다." });
    }
    const part1State = JSON.parse(part1Room.state_json);
    if (part1State.phase !== "ended") {
      return res.status(400).json({ ok: false, error: "1부 게임이 아직 끝나지 않아 등수가 확정되지 않았습니다." });
    }
    part1Match = deriveRanksFromPart1(
      part1Room,
      humanPlayers.map((p) => ({ id: p.id, name: p.name }))
    );
    ranks = { ...part1Match.ranks, ...ranks };
    part1Assets = { ...part1Match.part1Assets, ...part1Assets };
  }

  let gameState;
  try {
    gameState = Game2.initState(
      allPlayers.map((p) => ({ id: p.id, name: p.name, isBot: !!p.is_bot, characterId: p.character_id || null })),
      ranks,
      part1Assets,
      now()
    );
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const newVersion = persistState(room, gameState, "경매 시작", auctionStatusFor(gameState.phase));
  res.json({
    ok: true,
    stateVersion: newVersion,
    players: getPlayers(room.code).map(publicPlayer),
    part1Match, // fromPart1RoomCode를 안 넘겼으면 null. 넘겼으면 { matched, unmatched, ranks, part1Assets }
  });
});

// 2부 투표 열기: 14개 품목 경매가 전부 끝난 뒤(table-review) 관리자가 준비되면 5분 투표를 시작합니다.
app.post("/api/rooms/:code/admin/start-vote", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "auction") {
    return res.status(400).json({ ok: false, error: "이 방은 만찬경매 방이 아닙니다." });
  }
  const state = JSON.parse(room.state_json);
  Game2.tick(state, now());
  try {
    Game2.startVoting(state, now());
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const newVersion = persistState(room, state, "투표 시작", auctionStatusFor(state.phase));
  res.json({ ok: true, stateVersion: newVersion, state: Game2.serializeForClient(state, { forAdmin: true }) });
});

// 2부 투표 조기 종료: 5분을 다 기다리지 않고 관리자가 즉시 마감합니다.
app.post("/api/rooms/:code/admin/close-vote", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (!requireAdmin(req, res, room)) return;
  if (room.game_mode !== "auction") {
    return res.status(400).json({ ok: false, error: "이 방은 만찬경매 방이 아닙니다." });
  }
  const state = JSON.parse(room.state_json);
  try {
    Game2.closeVoting(state, now());
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const newVersion = persistState(room, state, "투표 조기 종료", auctionStatusFor(state.phase));
  res.json({ ok: true, stateVersion: newVersion, state: Game2.serializeForClient(state, { forAdmin: true }) });
});

// 2부 시청자 투표: 로그인 없는 공개 링크에서 호출됩니다. 방 참가자 토큰이 아니라 브라우저에
// 저장된 voterToken + 접속 IP 조합으로 중복 투표를 막습니다(로그인 시스템이 없는 만큼 완벽한
// 부정 방지는 아니라는 점을 2부 규칙서에 명시해 두었습니다).
app.post("/api/rooms/:code/vote", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: "존재하지 않는 방 코드입니다." });
  if (room.game_mode !== "auction") {
    return res.status(400).json({ ok: false, error: "이 방은 만찬경매 방이 아닙니다." });
  }
  const { voterToken, targetPlayerId } = req.body || {};
  if (!voterToken || !targetPlayerId) {
    return res.status(400).json({ ok: false, error: "요청에 필요한 값이 빠졌습니다." });
  }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const voterKey = crypto.createHash("sha256").update(`${voterToken}:${ip}`).digest("hex");

  const state = JSON.parse(room.state_json);
  const tickChanged = Game2.tick(state, now());
  try {
    Game2.submitVote(state, voterKey, targetPlayerId, now());
  } catch (e) {
    // 투표는 실패했더라도, 위 tick()이 마침 마감 시점을 감지해 상태를 바꿨다면 그 결과는 저장합니다.
    if (tickChanged) persistState(room, state, "투표 마감(자동)", auctionStatusFor(state.phase));
    return res.status(400).json({ ok: false, error: e.message });
  }
  persistState(room, state, "시청자 투표", auctionStatusFor(state.phase));
  res.json({ ok: true });
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

  // status 컬럼도 되돌아간 상태의 phase에 맞게 함께 갱신해야 함. (예전 버그: 강제 종료 후
  // 되돌리기를 하면 state.phase는 다시 playing이 되는데 rooms.status는 ended로 남아서,
  // 화면에는 계속 "게임 종료"로 표시되는 불일치가 생겼었음)
  const targetState = JSON.parse(target.state_json);
  const newStatus = targetState.phase === "ended" ? "ended" : targetState.phase === "waiting" || !targetState.phase ? "waiting" : "playing";

  db.prepare("UPDATE rooms SET state_json = ?, state_version = ?, status = ?, updated_at = ? WHERE code = ?").run(
    target.state_json,
    target.state_version,
    newStatus,
    now(),
    room.code
  );
  if (rows[0]) db.prepare("DELETE FROM snapshots WHERE id = ?").run(rows[0].id);

  res.json({ ok: true, stateVersion: target.state_version, state: targetState });
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
      "INSERT INTO players (id, room_code, name, seat, is_bot, character_id, token, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    (data.players || []).forEach((p) =>
      ins.run(p.id, room.code, p.name, p.seat, p.is_bot, p.character_id != null ? p.character_id : null, p.token, p.last_seen)
    );
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
