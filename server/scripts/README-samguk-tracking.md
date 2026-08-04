# 후국지 데이터 갱신

공개 화면에는 `검수대기`를 노출하지 않는다. 후보 관측은 로컬 NDJSON 큐에만 보관하고, 아래 조건을 만족한 최신값만 완전한 스냅샷으로 Google Sheet `관측입력`에 추가한다.

- 현재 Google Sheet 값은 기준값으로 즉시 사용
- Gamcom은 3개국 90명 완전 매칭 뒤 숫자 필드의 더 큰 값만 채택하고 문자열은 원장 빈칸만 보완
- Sheet·에펨코리아·방송 중 서로 다른 두 출처가 24시간 안에 같은 값을 확인
- 방송 OCR만 사용할 때는 신뢰도 0.95 이상인 서로 다른 두 프레임이 같은 값을 확인
- 같은 최신 시각의 검증값이 충돌하면 직전 기준값 유지

## 흐름

`Google Sheet 기준값 + Gamcom 보조자료 + FMK 구조화 입력 + 방송 ROI OCR → 관측입력 → 현재현황 + 장비현황 → /api/samguk → 파워랭킹`

파워 v1.6은 레벨·기량, 장비 강화, 각인, 말을 합산한다. 기량은 무력·기민·기력·지모 원값의 합계를 다른 환산 없이 표시 파워에 1:1로 더한다. 결측일 때만 항목별 하·상한 범위를 유지한다. 장비는 무기 60%·흉갑 30%·각갑 10%를 공통 적용하고 군주 두갑 15%를 추가 보너스로 더한다. 결측 구성요소에는 가중치를 재분배하거나 0점을 넣지 않고 가능한 범위를 유지하며, 화면 순위는 우리 시트에서 실제 확인된 구성요소의 하한점수로 정렬하고 범위 중앙값은 추정치로 함께 표시한다. 수집률 85%는 순위 포함 기준이 아니라 신뢰도 플래그다. `confirmed`는 수집률 100%, 현재현황·장비현황 교차검증, 레벨·기량 비교 표본 임계치가 모두 충족될 때만 사용하며, 나머지는 `provisional` 또는 `insufficient(수집 중·참고)`로 표시한다. 최대체력·정보창 체력·공격력·방어력·전투 비율·말 최대체력·평타피해는 비교 보조 관측이며 파워 v1.6 점수에는 넣지 않는다. 장비현황 빈칸은 미관측이며 미장착 슬롯은 `없음`, 일반 장수의 두갑 슬롯은 `해당없음`으로 명시한다.

## FMK 관측 입력

확인한 게시물 URL과 값은 아래처럼 직접 구조화해 넣을 수 있다. 자동 monitor는 5분에 한 번 `강` 검색 결과 한 페이지만 읽고, 최근 글 중 `참가자명 + 명확한 장비 슬롯 + N강`이 제목 또는 본문에 함께 적힌 경우만 같은 queue에 `fmkorea` 관측으로 넣는다. 실패·도전·가정·질문·부정, 슬롯이 모호한 `방어구` 표현은 버리고 문서번호 cache로 재요청을 막는다. FMK 한 출처만으로는 승격되지 않으며 기존 Sheet·방송 관측과 값이 일치해야 반영된다. HTTP 429/430은 `Retry-After`와 연속 제한 횟수를 state에 보존하고 10분부터 지수 backoff해 최대 1시간 동안 재요청하지 않는다.

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

서버 cron에서 켤 때는 HLS worker와 동일한 `SAMGUK_OBSERVATION_QUEUE_PATH`를 지정하고 `SAMGUK_FMKOREA_MONITOR_ENABLED=1`을 설정한다. 시즌 경계는 기본값 `2026-08-04T10:36:40.000Z`를 사용하며 `SAMGUK_SEASON_START_AT`으로 밀리초 단위 UTC ISO 시각을 명시할 수 있다. 잘못된 시각은 설정 오류로 시작을 중단하고, 경계보다 먼저 작성된 게시물은 관측과 문서 processed cache에 모두 넣지 않는다. 필요하면 `SAMGUK_FMKOREA_STATE_PATH`와 `{ "P001": ["검증된 별칭"] }` 형식의 `SAMGUK_FMKOREA_ALIASES_PATH`를 지정한다. 한 실행은 검색 1페이지만 읽고 상세 확인 대상은 최대 6개이며, 최소 실행 간격은 5분이다. 수동 1회 실행은 다음과 같다.

```bash
node scripts/samguk-fmkorea-gear-monitor.js \
  --queue /절대/경로/observations.ndjson \
  --state /절대/경로/fmkorea-state.json
```

지원 필드는 `level`, `horse`, `horseLevel`, `weapon`, `helmet`, `armor`, `shoes`, `strength`, `agility`, `vitality`, `intelligence`, `powerScore`, `maxHealth`, `attackPower`, `basicAttackDamage`, `basicAttackSampleCount`, `basicAttackTarget`, `combatConditions`, `healthStat`, `activeGeneral`, `defense`, `attackPowerBonusPct`, `damageReductionPct`, `criticalChancePct`, `criticalDamagePct`, `skillCooldownReductionPct`, `skillDamageBonusPct`, `moveSpeedBonusPct`, `horseMaxHealth`, `strengthBonus`, `agilityBonus`, `vitalityBonus`, `intelligenceBonus`, `attackPowerIncrease`, `moveSpeedIncrease`, `healthIncrease`, `skillHasteIncrease`다. 정보창 비율은 `5%=5`인 percentage-point로 저장한다. `attackPower`는 정보창 공격력이고 `basicAttackDamage`는 동일 대상·동일 조건의 비치명 기본공격 표본 대표값이다. 평타 관측은 `basicAttackSampleCount`, `basicAttackTarget`, `combatConditions`를 함께 기록한다. 적토마는 확인된 정확값인 `horseMaxHealth=1700 → horseLevel=0`, `1900 → 1`만 사용하며 중간값이나 이후 단계를 외삽하지 않는다.

절기창은 `skillBuild` canonical v1 JSON으로 저장하며, 프리셋·보유 포인트와 정확히 6개의 장수 스킬명·필요 포인트·배분 포인트가 다중 확대 OCR에서 모두 일치할 때만 채택한다.

## Google Sheet 연결

운영 원장은 [SOOPNOTICE 후국지 운영원장](https://docs.google.com/spreadsheets/d/1yMUytX11t-SzB9Tz9tpizj0Dyc1iIC2H2utQpycUuTQ/edit)이다. 사이트의 무인증 CSV 조회를 위해 일반 액세스는 `링크가 있는 모든 사용자: 뷰어`로 두되 편집자는 별도로 제한한다. 공개 원장에는 secret, 로컬 경로, 비공개 메모를 넣지 않는다.

1. Sheet에 바인딩된 Apps Script 프로젝트에 아래 파일을 순서대로 넣고 저장한다.
   - `google-apps-script/samguk-sheet-seed.generated.gs`
   - `google-apps-script/samguk-sheet-setup.gs`
   - `google-apps-script/samguk-observation-webhook.gs`
   - `google-apps-script/samguk-gamcom-sync.gs`
   - `google-apps-script/samguk-public-sheet-sync.gs`
2. 소유자 계정으로 `setupSamgukSheet()`를 실행한다. 14개 운영 탭, 90명, 60개 영토, 수식, 드롭다운, 필터와 보호가 멱등 적용되며 구형 탭은 `백업_...`으로 숨김 보존된다.
3. 추가 관리자는 Script Property `SAMGUK_SHEET_ADMIN_EMAILS`에 쉼표로 구분해 등록한다. 보호만 다시 설치할 때는 `reapplySamgukSheetProtections()`를 실행한다.
4. Script Property에 `SAMGUK_WEBHOOK_SECRET`과 필요하면 `SAMGUK_SPREADSHEET_ID`를 저장한다.
5. 웹 앱 `/exec` URL과 같은 secret을 서버의 `SAMGUK_SHEET_WEBHOOK_URL`, `SAMGUK_SHEET_WEBHOOK_SECRET`에 저장한다. 평문 env 대신 `SAMGUK_SHEET_WEBHOOK_URL_PATH`, `SAMGUK_SHEET_WEBHOOK_SECRET_PATH`로 현재 사용자 소유의 0400/0600 일반 파일을 지정할 수 있으며 평문 env가 경로 설정보다 우선한다. Apps Script 응답 제한은 `SAMGUK_SHEET_WEBHOOK_TIMEOUT_MS`로 조정하며 기본 30초, 최대 60초다.
6. 먼저 `SAMGUK_TRACKING_ENABLED=1`, `SAMGUK_TRACKING_WRITE_ENABLED=0`으로 dry-run을 확인한다.
7. 정상일 때만 `SAMGUK_TRACKING_WRITE_ENABLED=1`로 전환한다.

### Gamcom 보조자료

[위](https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84?season=2)·[촉](https://gamcom-3kingdom.vercel.app/factions/%EC%B4%89?season=2)·[오](https://gamcom-3kingdom.vercel.app/factions/%EC%98%A4?season=2) 페이지는 우리 원장을 대체하지 않는다. 운영 서버는 `SAMGUK_GAMCOM_MONITOR_ENABLED=1`일 때 격리된 headless Chromium 세 개로 세 페이지를 매분 병렬 수집하며, `SAMGUK_TRACKING_WRITE_ENABLED=1`일 때만 상승분을 batch 저장한다. process 간 lock으로 reload·수동 실행 중복을 막고 종료 시 browser process group과 임시 profile을 회수한다. 수동 확인은 `node scripts/samguk-sync-gamcom-chromium.js`로 dry-run하며, OAuth writer 구성에서만 `--write`를 명시한다. 매번 국가별 30명과 우리 원장 90명의 닉네임·국가가 전부 일치해야 쓰며, 숫자는 `MAX(우리값, Gamcom값)`, 세력·직업·말은 우리 값을 우선한다. 레벨·강화·능력치·원본 무력점수는 이후 더 낮은 관측이 들어와도 현황에서 내려가지 않는다. 원문에 갱신시각이 없으므로 수집시각을 관측시각으로 쓰고 `원문 갱신시각 미제공`을 남긴다. 실제 상승분만 `관측입력`에 `시트+Gamcom`·`기준값` 스냅샷으로 추가하며, 이는 두 출처의 값이 같다는 의미의 `교차검증`과 구분한다. Apps Script 구현은 수동 대체 경로지만 Vercel 보안 checkpoint가 Apps Script 요청을 제한할 수 있다.

### 공개 현황·제보 시트

`installSamgukPublicSheet()`를 소유자 계정으로 한 번 실행하면 별도 공개 Spreadsheet를 생성하고 즉시 캐시를 우회한 정상 API 90명을 채운 뒤 `syncSamgukPublicSheet()` 5분 트리거와 설치형 `handleSamgukPublicEdit()` 트리거를 설치한다. 설치 결과의 URL을 공개 링크로 사용한다. 레벨·강화·무/민/기/지·최대체력·공격력처럼 누적되는 수치는 운영원장의 확인된 최고값을 사용하고, 장비·장수 변경으로 내려갈 수 있는 동적 정보창 수치는 최신 관측값을 사용한다.

- 일반 액세스는 `링크가 있는 모든 사용자: 뷰어`이며 편집자의 권한 재공유는 끈다.
- 편집 요청을 승인한 Google 계정은 `수정제안`의 `player_id`, `field_key`, 제안값·관측시각·출처·HTTPS 근거·설명만 수정할 수 있다.
- 출력·상태·승인원장·코드표는 보호하고, 수식 입력은 제거한다.
- 운영자가 처리상태를 `승인`으로 바꾼 상승값만 `관측입력`에 `시트`·교차검증수 1·`기준값`으로 기록한다. 공개 사본 자체는 독립 교차검증 출처로 세지 않는다.
- 잘못 승인한 행은 처리상태를 `철회`로 바꾼다. 운영원장의 원행을 삭제하지 않고 검증상태를 `철회`로 바꿔 단조 최고값 계산에서 제외한다.
- 공개 표시 점수는 사이트 파워 v1.6 하한점수에 125를 곱한 정수다. 기량은 네 원값 합계를 파워에 1:1로 더한다. 장비는 무기 60%·흉갑 30%·각갑 10%를 공통 적용하고 군주 두갑 15%를 추가한다. 말은 담운마 0, 금표마 8.75, 백룡마 17.5, 현풍마 26.25, 적토마 35의 등급 기본점수에 강화점수를 더한다.

Apps Script를 배포하지 않는 단일 서버 운영에서는 전용 OAuth writer도 사용할 수 있다. OAuth 계정은 원장 소유자 또는 보호 관리자여야 하며 다른 writer와 병행하지 않는다.

```bash
python3 scripts/samguk-google-oauth.py \
  --client-secret /보안/경로/client_secret.json \
  --token /보안/경로/samguk-google-oauth.json
```

발급 파일과 상위 디렉터리는 각각 `0600`, `0700`이어야 한다. 서버에는 `SAMGUK_SHEET_WRITE_MODE=oauth`, `SAMGUK_GOOGLE_OAUTH_TOKEN_PATH`, `SAMGUK_SHEET_WRITER_LOCK_PATH`를 절대 경로로 지정한다. writer는 `관측입력!A:AY` 헤더·`참가자`·`Asia/Seoul` timezone을 확인하고, A:AY가 모두 빈 첫 행 하나만 OS lock 안에서 기록한 뒤 전체 행을 재조회한다. HUD 최대체력·평타 관측은 `관측입력!Y:AC`에서 `현재현황!AE:AI`로, 공격력은 `관측입력!AE`에서 `현재현황!AJ`로, 정보창·말 최대체력은 `관측입력!AF:AP`에서 `현재현황!AK:AU`로, 기량 보너스·증가량은 `관측입력!AQ:AX`에서 `현재현황!AV:BC`로, canonical 절기 배분은 `관측입력!AY`에서 `현재현황!BD`로 전달된다. OAuth 앱이 Testing 상태면 refresh token이 단기 만료될 수 있으므로 장기 무인 운영 전 Google OAuth publishing 상태를 확인한다.

fallback 기준값이 바뀌면 `node scripts/generate-samguk-sheet-seed.js`로 설치 seed를 다시 생성하고 `--check`로 동기화를 검증한다. 공개 reader는 gviz `headers=1`로 첫 행을 고정하며 `현재현황` 90명, `영토현황` 60개, `게임정보` 1행 이상이 모두 정상일 때만 새 데이터를 채택한다.

worker와 서버 cron의 `SAMGUK_OBSERVATION_QUEUE_PATH`는 반드시 같은 절대 경로여야 한다. `SAMGUK_PROMOTION_AUDIT_PATH`도 queue와 다른 절대 경로로 지정한다. 반영 후 제거되는 원본 frame 근거는 해당 경로의 append-only NDJSON에 먼저 `fsync`되며, 모든 제거 대상을 확인한 뒤에만 queue를 압축한다. 기본 10MiB에 도달하면 원본 파일을 다시 쓰거나 지우지 않고 `.part-000001`, `.part-000002` 순서로 회전하며, 모든 segment는 `0600`으로 유지한다. 크기는 `SAMGUK_PROMOTION_AUDIT_SEGMENT_MAX_BYTES`로 조정할 수 있다. 방송 모니터 설정과 권한 조건은 `../workers/README-samguk-monitor.md`를 따른다.

## 후국지 원장 전환

`reset-samguk-hugukji-sheets.js`는 기본적으로 네트워크를 전혀 사용하지 않고 변경 계획만 JSON으로 출력한다.

```bash
node scripts/reset-samguk-hugukji-sheets.js --plan \
  --gamcom-seed-json /tmp/gamcom-season2-latest.json \
  --gamcom-territory-json /tmp/gamcom-season2-castles-latest.json
```

실제 실행 전 backend writer, HLS writer, Gamcom/FMK import, 공개시트 5분 trigger를 모두 중지해야 한다. 실행 모드는 운영원장과 공개시트의 숨김 탭을 포함한 모든 탭을 각각 새 Spreadsheet에 `spreadsheets.create + sheets.copyTo`로 복사한 뒤, 탭별 전체 grid의 값·수식 fingerprint를 백업에서 다시 읽어 원본과 대조한다. grid는 탭당 2백만 셀·전체 8백만 셀 안전 한도를 넘으면 변경 전에 중단한다. 백업 중 원본 fingerprint가 바뀌지 않은 경우에만 정해진 범위를 초기화하며, 중간 실패 시 생성한 백업을 보존하고 자동 rollback이나 재실행은 하지 않는다.

실행에는 Sheets 단일 scope OAuth token, `SAMGUK_HUGUKJI_RESET_EXECUTION_ALLOWED=1`, `--execute`, `--writers-paused`, `--confirm RESET-hugukji-2026-08-04`와 두 seed 경로가 모두 필요하다. token은 인자 `--token` 또는 `SAMGUK_GOOGLE_OAUTH_TOKEN_PATH`로만 지정하며 plan 모드에서는 읽지 않는다. seed는 파일의 선언 hash를 신뢰하지 않고 코드에 고정한 2026-08-04 20:54 KST 스냅샷의 envelope·정렬 rows 결정적 SHA-256과 일치해야 한다. roster는 season2 90명 exact-set/국가를 검증해 참가자 세력·직업 및 새 관측·외부참고를 시드한다. territory는 60개 ID·번호·좌표, 소유 `8:위/33:촉/42:촉/47:오`, 국가별 수도 3개, 특수지 0개를 검증해 새 TINIT baseline으로 쓴다.

초기화는 각 대상 탭의 실제 grid 마지막 행까지 지운 뒤 90명·60개만 다시 쓴다. 따라서 관측입력·영토입력·공개 출력·코드표의 92행 이후에 남은 이전 시즌 행도 제거된다. `게임정보`에는 `시즌 | season_id | hugukji-2026-08-04` marker를 정확히 한 행 설치하고, 공개 `안내` A1:B16의 삼국지 문구를 후국지로 바꾼다. 완료 전 참가자·방송모니터링·관측·외부참고·영토입력/현황·현재현황·공개 전체 대상 범위를 수식 포함 계획값과 deep read-back 대조한다.
