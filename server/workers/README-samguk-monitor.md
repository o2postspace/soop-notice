# 삼국지 방송 화면 관측 worker

이 worker는 방송 원본이나 채팅을 수집하지 않고, 사용자가 지정한 숫자 UI의 ROI crop만 OCR한 뒤 `samguk-observations` NDJSON 관측값으로 기록한다. `SAMGUK_MONITOR_ENABLED=1`과 config의 `permissionConfirmed=true`가 모두 없으면 SOOP 조회와 화면 캡처를 시작하지 않는다.

방송 권리자와 SOOP 정책상 허용된 화면만 관측해야 한다. 채팅 영역은 ROI에 넣지 말고, crop은 기본값 `cropRetentionMs: 0`으로 OCR 직후 삭제한다. 디버깅 보관도 최대 5분으로 제한된다.

## 설정

1. `config/samguk-monitor.example.json`을 `~/.config/soop-notice/samguk-monitor.json`으로 복사한다.
2. 방송 화면을 고정한 뒤 필요한 능력치 영역만 `targets[].rois[]`에 지정한다. target 기본값은 `enabled: false`다.
3. 로컬 OCR adapter의 절대 경로를 지정한다. adapter는 stdout에 아래 JSON 하나만 출력해야 한다.

```json
{"value": 123, "confidence": 0.98}
```

지원 template은 `{input}`, `{field}`, `{playerId}`, `{targetId}`, `{roiId}`다. 명령은 shell 없이 executable과 인자 배열로 실행된다.

대기 중 LIVE 확인은 기본 60초, LIVE 중은 15초다. 실제 OCR 주기는 target의 `sampleIntervalMs`로 더 느리게 설정할 수 있다.

## user systemd

`systemd/soop-samguk-monitor.example.service`는 재부팅 후 자동 시작을 위한 user service 예시다. `StateDirectory`가 권한 `0700`의 관측 큐 디렉터리를 만들며, 예시 그대로는 `SAMGUK_MONITOR_ENABLED=0`이라 외부 조회 없이 종료한다. 권한 확인, 실제 config와 ROI 검증, 수동 1회 테스트가 끝난 뒤에만 활성화한다.

worker와 서버 승격 cron은 반드시 같은 `SAMGUK_OBSERVATION_QUEUE_PATH`를 사용해야 한다. 예시 unit의 `%S/soop-notice/samguk-monitor/observations.ndjson`이 실제 경로로 확정되면 서버 `.env`에도 그 절대 경로를 넣고, 먼저 `SAMGUK_TRACKING_ENABLED=1`의 dry-run 결과를 확인한 뒤 쓰기를 켠다.
