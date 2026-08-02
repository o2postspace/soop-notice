# 삼국지 데이터 갱신

공개 화면에는 `검수대기`를 노출하지 않는다. 후보 관측은 로컬 NDJSON 큐에만 보관하고, 아래 조건을 만족한 최신값만 완전한 스냅샷으로 Google Sheet `관측입력`에 추가한다.

- 현재 Google Sheet 값은 기준값으로 즉시 사용
- Gamcom은 3개국 90명 완전 매칭 뒤 숫자 필드의 더 큰 값만 채택하고 문자열은 원장 빈칸만 보완
- Sheet·에펨코리아·방송 중 서로 다른 두 출처가 24시간 안에 같은 값을 확인
- 방송 OCR만 사용할 때는 신뢰도 0.95 이상인 서로 다른 두 프레임이 같은 값을 확인
- 같은 최신 시각의 검증값이 충돌하면 직전 기준값 유지

## 흐름

`Google Sheet 기준값 + Gamcom 보조자료 + FMK 구조화 입력 + 방송 ROI OCR → 관측입력 → 현재현황 + 장비현황 → /api/samguk → 파워랭킹`

파워 v1은 레벨·기량 30%, 장비 강화 35%, 각인 20%, 말 강화 15%의 고정 가중치를 합산한다. 결측 구성요소에는 가중치를 재분배하거나 0점을 넣지 않고 가능한 0~100 범위를 유지하며, 화면 순위는 우리 시트에서 실제 확인된 구성요소의 하한점수로 정렬하고 범위 중앙값은 추정치로 함께 표시한다. 수집률 85%는 순위 포함 기준이 아니라 신뢰도 플래그다. `confirmed`는 수집률 100%, 현재현황·장비현황 교차검증, 레벨·기량 비교 표본 임계치가 모두 충족될 때만 사용하며, 나머지는 `provisional` 또는 `insufficient(수집 중·참고)`로 표시한다. 최대체력·정보창 체력·공격력·방어력·전투 비율·말 최대체력·평타피해는 비교 보조 관측이며 파워 v1 점수에는 넣지 않는다. 장비현황 빈칸은 미관측이며 미장착 슬롯은 `없음`, 일반 장수의 두갑 슬롯은 `해당없음`으로 명시한다.

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

지원 필드는 `level`, `horse`, `horseLevel`, `weapon`, `helmet`, `armor`, `shoes`, `strength`, `agility`, `vitality`, `intelligence`, `powerScore`, `maxHealth`, `attackPower`, `basicAttackDamage`, `basicAttackSampleCount`, `basicAttackTarget`, `combatConditions`, `healthStat`, `activeGeneral`, `defense`, `attackPowerBonusPct`, `damageReductionPct`, `criticalChancePct`, `criticalDamagePct`, `skillCooldownReductionPct`, `skillDamageBonusPct`, `moveSpeedBonusPct`, `horseMaxHealth`다. 정보창 비율은 `5%=5`인 percentage-point로 저장한다. `attackPower`는 정보창 공격력이고 `basicAttackDamage`는 동일 대상·동일 조건의 비치명 기본공격 표본 대표값이다. 평타 관측은 `basicAttackSampleCount`, `basicAttackTarget`, `combatConditions`를 함께 기록한다. 적토마는 확인된 정확값인 `horseMaxHealth=1700 → horseLevel=0`, `1900 → 1`만 사용하며 중간값이나 이후 단계를 외삽하지 않는다.

## Google Sheet 연결

운영 원장은 [SOOPNOTICE 삼국지 운영원장](https://docs.google.com/spreadsheets/d/1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY/edit)이다. 사이트의 무인증 CSV 조회를 위해 일반 액세스는 `링크가 있는 모든 사용자: 뷰어`로 두되 편집자는 별도로 제한한다. 공개 원장에는 secret, 로컬 경로, 비공개 메모를 넣지 않는다.

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

[위](https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84)·[촉](https://gamcom-3kingdom.vercel.app/factions/%EC%B4%89)·[오](https://gamcom-3kingdom.vercel.app/factions/%EC%98%A4) 페이지는 우리 원장을 대체하지 않는다. `installSamgukGamcomSync()`를 한 번 실행하면 즉시 동기화하고 `syncSamgukGamcom()` 15분 트리거를 하나만 설치한다. 매번 국가별 30명과 우리 원장 90명의 닉네임·국가가 전부 일치해야 쓰며, 숫자는 `MAX(우리값, Gamcom값)`, 세력·직업·말은 우리 값을 우선한다. 레벨·강화·능력치·원본 무력점수는 이후 더 낮은 관측이 들어와도 현황에서 내려가지 않는다. 같은 실행에서 [60칸 영토 API](https://gamcom-3kingdom.vercel.app/api/castles?fresh=1)도 전체 검증하고 ID·번호·좌표가 우리 원장과 모두 일치할 때 바뀐 영토만 `영토입력`에 추가한다. 원문에 갱신시각이 없으므로 수집시각을 관측시각으로 쓰고 `원문 갱신시각 미제공`을 남긴다. 참가자 자료는 `외부참고`에 수집시각·출처 URL·채택 필드·유지 필드를 남기고, 실제 상승분만 `관측입력`에 `시트+Gamcom`·`기준값` 스냅샷으로 추가한다. 이는 두 출처의 값이 같다는 의미의 `교차검증`과 구분한다.

### 공개 현황·제보 시트

`installSamgukPublicSheet()`를 소유자 계정으로 한 번 실행하면 별도 공개 Spreadsheet를 생성하고 즉시 정상 API 90명을 채운 뒤 `syncSamgukPublicSheet()` 15분 트리거와 설치형 `handleSamgukPublicEdit()` 트리거를 설치한다. 설치 결과의 URL을 공개 링크로 사용한다.

- 일반 액세스는 `링크가 있는 모든 사용자: 뷰어`이며 편집자의 권한 재공유는 끈다.
- 편집 요청을 승인한 Google 계정은 `수정제안`의 `player_id`, `field_key`, 제안값·관측시각·출처·HTTPS 근거·설명만 수정할 수 있다.
- 출력·상태·승인원장·코드표는 보호하고, 수식 입력은 제거한다.
- 운영자가 처리상태를 `승인`으로 바꾼 상승값만 `관측입력`에 `시트`·교차검증수 1·`기준값`으로 기록한다. 공개 사본 자체는 독립 교차검증 출처로 세지 않는다.
- 잘못 승인한 행은 처리상태를 `철회`로 바꾼다. 운영원장의 원행을 삭제하지 않고 검증상태를 `철회`로 바꿔 단조 최고값 계산에서 제외한다.
- 공개 표시 점수는 사이트 파워 v1.1 하한점수에 125를 곱한 정수이며 파워 산식 자체는 바꾸지 않는다.

Apps Script를 배포하지 않는 단일 서버 운영에서는 전용 OAuth writer도 사용할 수 있다. OAuth 계정은 원장 소유자 또는 보호 관리자여야 하며 다른 writer와 병행하지 않는다.

```bash
python3 scripts/samguk-google-oauth.py \
  --client-secret /보안/경로/client_secret.json \
  --token /보안/경로/samguk-google-oauth.json
```

발급 파일과 상위 디렉터리는 각각 `0600`, `0700`이어야 한다. 서버에는 `SAMGUK_SHEET_WRITE_MODE=oauth`, `SAMGUK_GOOGLE_OAUTH_TOKEN_PATH`, `SAMGUK_SHEET_WRITER_LOCK_PATH`를 절대 경로로 지정한다. writer는 `관측입력!A:AP` 헤더·`참가자`·`Asia/Seoul` timezone을 확인하고, A:AP가 모두 빈 첫 행 하나만 OS lock 안에서 기록한 뒤 전체 행을 재조회한다. HUD 최대체력·평타 관측은 `관측입력!Y:AC`에서 `현재현황!AE:AI`로, 공격력은 `관측입력!AE`에서 `현재현황!AJ`로, 정보창·말 최대체력은 `관측입력!AF:AP`에서 `현재현황!AK:AU`로 전달된다. OAuth 앱이 Testing 상태면 refresh token이 단기 만료될 수 있으므로 장기 무인 운영 전 Google OAuth publishing 상태를 확인한다.

fallback 기준값이 바뀌면 `node scripts/generate-samguk-sheet-seed.js`로 설치 seed를 다시 생성하고 `--check`로 동기화를 검증한다. 공개 reader는 gviz `headers=1`로 첫 행을 고정하며 `현재현황` 90명, `영토현황` 60개, `게임정보` 1행 이상이 모두 정상일 때만 새 데이터를 채택한다.

worker와 서버 cron의 `SAMGUK_OBSERVATION_QUEUE_PATH`는 반드시 같은 절대 경로여야 한다. `SAMGUK_PROMOTION_AUDIT_PATH`도 queue와 다른 절대 경로로 지정한다. 반영 후 제거되는 원본 frame 근거는 해당 경로의 append-only NDJSON에 먼저 `fsync`되며, 모든 제거 대상을 확인한 뒤에만 queue를 압축한다. 기본 10MiB에 도달하면 원본 파일을 다시 쓰거나 지우지 않고 `.part-000001`, `.part-000002` 순서로 회전하며, 모든 segment는 `0600`으로 유지한다. 크기는 `SAMGUK_PROMOTION_AUDIT_SEGMENT_MAX_BYTES`로 조정할 수 있다. 방송 모니터 설정과 권한 조건은 `../workers/README-samguk-monitor.md`를 따른다.
