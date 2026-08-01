# 삼국지 데이터 갱신

공개 화면에는 `검수대기`를 노출하지 않는다. 후보 관측은 로컬 NDJSON 큐에만 보관하고, 아래 조건을 만족한 최신값만 완전한 스냅샷으로 Google Sheet `관측입력`에 추가한다.

- 현재 Google Sheet 값은 기준값으로 즉시 사용
- Sheet·에펨코리아·방송 중 서로 다른 두 출처가 24시간 안에 같은 값을 확인
- 방송 OCR만 사용할 때는 신뢰도 0.95 이상인 서로 다른 두 프레임이 같은 값을 확인
- 같은 최신 시각의 검증값이 충돌하면 직전 기준값 유지

## 흐름

`Google Sheet 기준값 + FMK 구조화 입력 + 방송 ROI OCR → samguk-observations.ndjson → 5분 승격 cron → Apps Script webhook → 관측입력 → 현재현황/무력랭킹 → /api/samguk`

무력랭킹은 `무력점수`가 한 명이라도 있으면 그 열만 사용한다. 아직 없으면 화면에 `무력 스탯`이라고 명시해 임시 정렬하며 두 스케일은 섞지 않는다.

## FMK 관측 입력

게시물 자동 크롤링 대신 확인한 게시물 URL과 값을 구조화해 넣는다. 같은 입력은 hash로 중복 제거된다.

```bash
node scripts/samguk-submit-observation.js <<'JSON'
{
  "playerId": "P001",
  "field": "strength",
  "value": 100,
  "sourceType": "fmkorea",
  "sourceId": "post-문서번호-strength",
  "sourceUrl": "https://www.fmkorea.com/문서번호",
  "observedAt": "2026-08-02T05:00:00+09:00"
}
JSON
```

지원 필드는 `level`, `horse`, `horseLevel`, `weapon`, `helmet`, `armor`, `shoes`, `strength`, `agility`, `vitality`, `intelligence`, `powerScore`다.

## Google Sheet 연결

1. `build-samguk-tracker.py`로 만든 워크북을 운영 Sheet 구조에 반영한다.
2. Sheet에 바인딩된 Apps Script에 `google-apps-script/samguk-observation-webhook.gs`를 넣는다.
3. Script Property에 `SAMGUK_WEBHOOK_SECRET`과 필요하면 `SAMGUK_SPREADSHEET_ID`를 저장한다.
4. 웹 앱 `/exec` URL과 같은 secret을 서버의 `SAMGUK_SHEET_WEBHOOK_URL`, `SAMGUK_SHEET_WEBHOOK_SECRET`에 저장한다.
5. 먼저 `SAMGUK_TRACKING_ENABLED=1`, `SAMGUK_TRACKING_WRITE_ENABLED=0`으로 dry-run을 확인한다.
6. 정상일 때만 `SAMGUK_TRACKING_WRITE_ENABLED=1`로 전환한다.

worker와 서버 cron의 `SAMGUK_OBSERVATION_QUEUE_PATH`는 반드시 같은 절대 경로여야 한다. 방송 모니터 설정과 권한 조건은 `../workers/README-samguk-monitor.md`를 따른다.
