# 삼국지 90개 방송 HLS 관측 worker

운영 경로는 `samguk-hls-monitor.js`다. Chrome 탭 90개를 재생하지 않고 공개 LIVE의 SD HLS 최근 segment를 cursor로 이어 읽는다. 평소에는 48×27 gray frame으로 UI 여부만 판별하고, 정보·장비 UI 후보가 잡힌 방송만 그 순간의 HD 960×540 후보 frame을 즉시 보존한 뒤 OCR burst로 전환한다.

- 운영 `all-90` target: fallback roster의 P001~P090 정확히 90명(부분집합이면 시작 거부)
- LIVE 확인 뒤 SD 판별 주기: 2초, segment 내부는 0.25초 간격 8 frame
- 지연 시 catch-up: 최근 segment 최대 6개(현재 playlist 기준 약 12초)를 오래된 순서로 처리
- SD 동시성: 최대 40(실제 LIVE 수와 due task만큼만 사용)
- HD OCR burst: 0.5초 확인, 최대 동시 3개, 30초 고정
- 종료 방송 재확인: `idleIntervalMs` 기준 기본 60초(jitter 8% 적용 시 최대 약 64.8초)
- HLS URL: 메모리에만 60초 cache
- 영상·AID·HLS URL: 로그와 queue에 저장하지 않음
- 같은 segment: 다시 decode하지 않으며 cursor 이후 구간만 요청
- 같은 값: 서로 다른 화면 2장이 0.95 이상으로 일치할 때만 queue 기록

고정 ROI는 사용하지 않는다. 정보창과 장비 tooltip 위치가 매번 달라질 수 있으므로 OCR adapter가 960×540 전체 frame에서 panel과 항목을 찾고 여러 필드를 한 번에 반환한다. SD 후보 직후 HD 후보 frame을 최대 2장 0600 파일로 잠시 보존해 화면이 닫힌 뒤에도 OCR하고, 서로 다른 HLS segment에서 같은 값이 확인돼야 관측 queue에 넣는다. 보존 frame은 기본 30분 뒤 자동 삭제된다.

## 활성화 조건

다음 두 조건이 모두 충족되지 않으면 SOOP 조회를 시작하지 않는다.

1. 환경변수 `SAMGUK_HLS_MONITOR_ENABLED=1`
2. v2 config의 `permissionConfirmed=true`

공개·비밀번호 없는 LIVE만 지원한다. 로그인 cookie나 계정 token은 worker에 전달하지 않는다. 실제 상시 관측 전에는 방송 권리자와 [SOOP 이용약관](https://www.sooplive.co.kr/policy/policy1.html)의 허용 범위를 확인한다.

`config/samguk-hls-monitor.example.json`은 `all-90` mode이며 두 활성화 조건이 모두 꺼진 상태다. 파일을 `~/.config/soop-notice/samguk-hls-monitor.json`으로 복사한 뒤 설정한다. `all-90`에서는 `enabledPlayerIds` 부분집합을 허용하지 않는다. OCR adapter를 한 방송에서 수동 검증할 때만 다음처럼 명시적 dry-run mode를 사용한다.

```json
{
  "version": 2,
  "mode": "single-target-dry-run",
  "permissionConfirmed": true,
  "enabledPlayerIds": ["P001"]
}
```

heartbeat에는 `mode`, `totalTargetCount`, `enabledCount`, `disabledCount`, 정렬된 playerId 집합의 짧은 SHA-256인 `targetSetDigest`가 포함된다. playerId 원문, BJ ID, URL은 기록하지 않는다. LIVE가 확인된 target은 2초 주기로 추적하지만 offline target은 위 `idleIntervalMs`까지 재탐색이 늦어질 수 있으므로 둘을 같은 보장으로 해석하면 안 된다.

`sdSegmentsMissed`는 SD cursor의 sequence 공백이다. 같은 시간에 해당 target을 HD burst로 관측한 구간도 포함될 수 있으므로 단독으로 전체 관측 누락으로 해석하지 않는다. `hdSegmentsUnobserved`는 후보 burst 사이에 의도적으로 열지 않은 HD 구간이며, 기존 `segmentsMissed`는 두 값을 합친 호환용 합계다.

## OCR adapter 계약

현재 예제 config는 `ocr.enabled=false`라 UI 감지만 한다. OCR을 켤 때는 시작 시 최신 Google Sheet를 기준값으로 먼저 읽고 60초마다 갱신한다. 아직 Sheet에 승격되지 않은 로컬 두-frame 확인값은 overlay로 보존해 기준값이 뒤로 돌아가지 않는다. stale/fallback 자료만 있으면 시작하지 않으며, 갱신 실패 때는 마지막 정상 기준값을 유지한다. 별도 Python 환경의 실행 파일과 adapter script를 지정하고, PNG는 stdin으로만 넣으며 adapter는 stdout에 v2 JSON 한 개만 출력해야 한다.

```json
{
  "ocr": {
    "enabled": true,
    "profileId": "stats-panel-v1",
    "command": "/absolute/venv/bin/python",
    "args": [
      "/absolute/path/server/scripts/samguk_ocr_adapter.py",
      "--profile={profileId}",
      "--model-dir=/absolute/path/rapidocr-models"
    ]
  }
}
```

```json
{
  "version": 2,
  "profileId": "stats-panel-v1",
  "panelVisible": true,
  "results": [
    {"field": "level", "value": 42, "confidence": 0.99},
    {"field": "weapon", "value": 5, "confidence": 0.98},
    {"field": "strength", "value": 86, "confidence": 0.97}
  ]
}
```

허용 필드는 `level`, `horse`, `horseLevel`, `weapon`, `helmet`, `armor`, `shoes`, `strength`, `agility`, `vitality`, `intelligence`, `maxHealth`, `attackPower`, `healthStat`, `activeGeneral`, `defense`, `attackPowerBonusPct`, `damageReductionPct`, `criticalChancePct`, `criticalDamagePct`, `skillCooldownReductionPct`, `skillDamageBonusPct`, `moveSpeedBonusPct`, `horseMaxHealth`, `strengthBonus`, `agilityBonus`, `vitalityBonus`, `intelligenceBonus`, `attackPowerIncrease`, `moveSpeedIncrease`, `healthIncrease`, `skillHasteIncrease`다. `powerScore`는 OCR 원본으로 받지 않고 검증된 값에서 계산한다. adapter 인자 template은 `{profileId}`, `{playerId}`, `{targetId}`, `{bjId}`, `{observedAt}`만 지원한다.

현재 adapter는 군마영 강화 단계, 장비 강화 4종, 기량 4종과 보너스·증가량, 플레이어/말 HUD 최대체력과 정보창 전투 스탯을 실측 fixture로 검증한다. 정보창에서는 체력·현재 장수·공격력·방어력과 공격력 증가, 피해 감소, 치명타 확률/피해, 절기 대기시간 감소/피해 증가, 이동속도 증가를 구조 기반으로 한 번에 읽는다. 강화창은 현재 단계→다음 단계의 연속값을 3개 배율로 합의하고 실제 장비 icon template까지 일치할 때만 장비 종류와 현재 강화를 출력한다. 군마영은 `군마영` 제목, `장착·강화·합성` 탭 중 2개 이상, `강화하기` 버튼을 함께 확인하고 목표 단계 화살표가 아닌 현재 `N단계`만 `horseLevel`로 출력한다. HUD의 말 최대체력은 플레이어 최대체력과 분리하며, 실측이 확인된 적토마 `1700=0강`, `1900=1강`만 말 이름·강화값으로 변환하고 다른 값은 외삽하지 않는다. 구조 합의와 실제 fixture가 있는 패널만 0.95 자동쓰기 기준을 넘을 수 있으며, 값 합의가 깨지면 쓰지 않는다. `level`은 실제 방송 positive fixture를 확보하기 전까지 출력하지 않는다.

adapter 의존성은 `scripts/requirements-samguk-ocr.lock.txt`의 검증된 전체 pin으로 별도 venv에 설치한다. `requirements-samguk-ocr.txt`는 direct dependency 갱신용이다. detector·classifier·Korean recognizer ONNX 파일은 `--model-dir` 아래에 미리 두며 운영 중 다운로드하지 않는다. whole-frame에서 알려진 panel 구조를 찾고, 장비 tooltip은 발견된 종류 label 기준 상대 위치를 다시 읽으므로 고정 ROI를 사용하지 않는다. RapidOCR 로그와 원문 이미지는 stdout·stderr·queue에 기록하지 않는다.

## 자동 시작 예시

`systemd/soop-samguk-monitor.example.service`는 재부팅 후 자동 시작용 user service 예시다. 예시 그대로는 `SAMGUK_HLS_MONITOR_ENABLED=0`이어서 즉시 안전 종료한다. `single-target-dry-run` OCR 수동 검증, `all-90` 전수 검증, 권한 확인이 모두 끝난 뒤에만 복사·enable한다.

worker와 승격 cron은 같은 `SAMGUK_OBSERVATION_QUEUE_PATH`를 사용해야 한다. queue에는 값이 바뀐 경우 서로 다른 HLS media segment에서 재확인된 frame 2개만 들어가며, promoter가 distinct evidence hash와 최신성을 다시 검증한 뒤 Google Sheet에 반영한다.

기존 `samguk-monitor.js`는 X11 고정 ROI 실험용으로 남아 있으며 90개 방송 운영에는 사용하지 않는다.
