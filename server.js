// 한가위 만찬 경매전 - 1부 게임 서버
// 공통 엔진 초기 스캐폴딩: 정적 파일 서빙 + 헬스체크 + 상태 API 기본틀
const path = require("path");
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, part: 1, name: "만찬 경매전", ts: Date.now() });
});

// TODO: /api/room, /api/state, /api/action, 결산 코드 발급 API 등은 다음 커밋에서 구현
app.get("/api/status", (req, res) => {
  res.json({ status: "설계 완료, 게임 로직 구현 중", updated: "2026-09-07" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[part1] listening on ${PORT}`);
});
