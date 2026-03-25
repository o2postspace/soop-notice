# SOOP BJ 공지사항 대시보드 - 협업 가이드

## 빠른 시작 (Claude Code에서)

### 1. 레포 클론
```bash
git clone https://github.com/o2postspace/soop-notice.git
cd soop-notice
npm install
```

### 2. 환경변수 설정
`.env.local` 파일을 만들고 아래 값을 채우세요 (팀원에게 공유받기):
```
SUPABASE_URL=https://xlzrwihaeswkyywgnkjg.supabase.co
SUPABASE_ANON_KEY=<팀원에게 공유받기>
CRON_SECRET=<팀원에게 공유받기>
```

### 3. Supabase MCP 연결 (선택)
```bash
claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp"
```
재시작 후 Supabase 로그인하면 DB 직접 조회 가능.

### 4. 로컬 실행
```bash
npx vercel dev --yes
```

## 프로젝트 구조

```
api/
  notices.js              # GET /api/notices?offset=0&limit=8 - 공지 목록 (페이지네이션)
  cron/fetch-notices.js   # Cron - SOOP API → Supabase 수집
lib/
  bj-list.js              # BJ 목록 (아이디, 이름, 태그)
  supabase.js             # Supabase 클라이언트
public/
  index.html              # 프론트엔드 (순수 HTML/CSS/JS)
```

## 데이터 흐름

```
SOOP API → [Cron 1분] → Supabase notices 테이블
                              ↓
                    /api/notices (페이지네이션)
                              ↓
                    프론트엔드 (첫 8개 즉시 → 나머지 백그라운드)
```

## 주요 작업별 가이드

### BJ 추가/삭제
`lib/bj-list.js`의 `BJ_LIST` 객체 수정.
```js
newbjid: { name: "이름", tag: "분류" },
// 숫자로 시작하면 따옴표 필수
"1234abc": { name: "이름", tag: "분류" },
```

### 태그 종류
보라, 스타, 롤, 여캠, 왁타버스, 게임, 버츄얼, 배그, 먹방, 하데스, 메이플, 스포츠, 음악, 피파, 발로란트, 베그

### API 수정
- `api/notices.js` — Supabase에서 읽기, 페이지네이션 파라미터: `offset`, `limit`
- `api/cron/fetch-notices.js` — SOOP에서 가져와서 Supabase에 upsert

### 프론트엔드 수정
- `public/index.html` 단일 파일 (HTML + CSS + JS 모두 포함)
- 프레임워크 없음, 순수 JS

## Supabase DB 스키마

```sql
notices (
  id          bigserial PK,
  bj_id       text,
  bj_name     text,
  bj_tag      text,
  title_no    bigint UNIQUE,
  title_name  text,
  content_html text,
  reg_date    timestamptz,
  read_cnt    integer,
  is_pin      boolean,
  updated_at  timestamptz
)
```

## 배포
- Vercel에 GitHub 연동되어 있음 → `master` push 시 자동 배포
- 환경변수는 Vercel Dashboard에서 설정

## 주의사항
- `.env.local`은 절대 커밋 금지
- SOOP API rate limit 주의 — `fetch-notices.js`의 `BATCH_SIZE` 조절
- Vercel Cron 1분 간격은 Pro 플랜 전용
