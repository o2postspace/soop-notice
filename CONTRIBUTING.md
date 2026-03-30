# SOOP BJ 공지사항 대시보드 - 협업 가이드

## 사이트: https://soopnotice.com

## 빠른 시작

```bash
git clone https://github.com/o2postspace/soop-notice.git
cd soop-notice
npm install
```

### 환경변수 설정
`.env.local` 파일 생성 (팀원에게 공유받기):
```
SUPABASE_URL=https://xlzrwihaeswkyywgnkjg.supabase.co
SUPABASE_ANON_KEY=<팀원에게 공유>
CRON_SECRET=<팀원에게 공유>
GEMINI_API_KEY=<팀원에게 공유>
```

### Supabase MCP 연결 (선택)
```bash
claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp"
```
재시작 후 Supabase 로그인.

### 로컬 실행
```bash
npm run dev
```
http://localhost:3000 에서 테스트 가능. Cloudflare/Vercel 연동 불필요.

---

## 호스팅: Cloudflare Pages

Vercel에서 Cloudflare Pages로 이전됨. master push 시 GitHub Actions가 자동 배포.

### 코드 구조 (중요!)

API 코드가 **두 곳**에 있음:

| 폴더 | 형식 | 용도 |
|---|---|---|
| `api/` | Vercel (CommonJS) | **로컬 dev-server용** |
| `functions/` | Cloudflare Workers (ESM) | **프로덕션 배포용** |

### API 수정할 때 반드시!
**`api/` 수정하면 → `functions/` 도 같이 수정해야 함.**

예시: `api/notices.js` 수정 → `functions/api/notices.js`도 동일하게 수정

차이점:
```js
// api/ (Vercel/로컬)
const { supabase } = require("../lib/supabase");
module.exports = async function handler(req, res) {
  res.status(200).json(data);
};

// functions/ (Cloudflare)
import { createSupabase } from "../_shared/supabase.js";
export async function onRequestGet(context) {
  return new Response(JSON.stringify(data), { status: 200 });
}
```

### BJ 추가/삭제 시
1. `lib/bj-list.js` 수정
2. `functions/_shared/bj-list.js`에도 동일 내용 반영 (ESM export 형식)
3. push → 자동 배포

---

## 브랜치 전략

### 브랜치 구조
```
master          ← 프로덕션 (GitHub Actions → Cloudflare 자동 배포)
  ├── feat/*    ← 새 기능
  ├── fix/*     ← 버그 수정
  ├── refactor/*← 리팩토링
  └── hotfix/*  ← 긴급 수정 (master에서 분기)
```

### 브랜치 네이밍
```
feat/검색기능
feat/다크모드
fix/시간표시-버그
fix/모바일-레이아웃
refactor/api-캐싱
hotfix/cron-인증-오류
```

### 작업 흐름

#### 1. 새 작업 시작
```bash
git checkout master
git pull origin master
git checkout -b feat/내기능
```

#### 2. 작업 중 커밋
```bash
git add <파일>
git commit -m "설명"
```

커밋 메시지 형식:
```
feat: 검색 기능 추가
fix: 시간 표시 9시간 차이 수정
refactor: API 응답 캐싱 구조 변경
style: 카드 레이아웃 간격 조정
docs: CONTRIBUTING.md 업데이트
```

#### 3. PR 올리기 전에 최신 master 반영
```bash
git checkout master
git pull origin master
git checkout feat/내기능
git merge master
```

**충돌이 나면?**
```bash
# 충돌 파일 열어서 수동 해결 (<<<<<<< 마커 찾기)
git add <충돌해결한파일>
git commit
```

#### 4. PR 생성
```bash
git push origin feat/내기능
```
GitHub에서 Pull Request 생성 → `master` 로 머지 대상 설정.

#### 5. 코드 리뷰 후 머지
- PR에서 리뷰 → Approve → **Squash and merge**
- 머지 후 브랜치 삭제

#### 6. 로컬 정리
```bash
git checkout master
git pull origin master
git branch -d feat/내기능
```

### 동시 작업 예시
```
나:   master → feat/검색기능 → 작업중...
친구: master → feat/다크모드 → 작업 완료 → PR → master에 머지

# 친구가 먼저 머지함. PR 올리기 전에:
git checkout master && git pull
git checkout feat/검색기능
git merge master
# 충돌 없으면 바로 push → PR
```

---

## 파일별 역할

| 파일 | 역할 |
|---|---|
| `public/index.html` | 프론트엔드 (HTML+CSS+JS) |
| `api/notices.js` | 공지 목록 API (로컬용) |
| `api/notice-content.js` | 공지 본문 API (로컬용) |
| `api/schedules.js` | 캘린더 스케줄 API (로컬용) |
| `api/cron/fetch-notices.js` | SOOP → Supabase 수집 |
| `api/cron/parse-schedules.js` | 인기 BJ 공지 → 캘린더 파싱 |
| `api/cron/parse-collabs.js` | 합방 감지 (다른 BJ 공지에서) |
| `functions/` | Cloudflare Workers 배포용 (위 api/와 동일 로직) |
| `lib/bj-list.js` | BJ 목록 (로컬용) |
| `functions/_shared/bj-list.js` | BJ 목록 (배포용, ESM) |
| `dev-server.js` | 로컬 테스트 서버 |

### 데이터 흐름
```
SOOP API → [cron-job.org 1분] → Supabase notices 테이블
                                      ↓
                            /api/notices (CDN 60초 캐시)
                                      ↓
                            soopnotice.com 프론트엔드

공지 본문 → [Gemini Flash 30분] → schedules 테이블 → 캘린더
```

### Supabase DB
```sql
notices (bj_id, bj_name, title_no UNIQUE, title_name, content_html, reg_date, read_cnt, is_pin)
schedules (bj_id, bj_name, title_no, broadcast_start, description)
```

---

## 배포

- `master`에 push/머지 → **GitHub Actions → Cloudflare Pages 자동 배포**
- 환경변수: Cloudflare Dashboard → Pages → soop-notice → Settings
- Cron: [cron-job.org](https://cron-job.org)
  - `/api/cron/fetch-notices` (1분)
  - `/api/cron/parse-schedules` (30분)
  - `/api/cron/parse-collabs` (30분)

## 주의사항

- `.env.local`은 절대 커밋 금지
- `master`에 직접 push 금지 → 반드시 PR로
- **`api/` 수정하면 `functions/`도 같이 수정!**
- **`lib/bj-list.js` 수정하면 `functions/_shared/bj-list.js`도 동기화!**
- `reg_date`는 KST인데 DB에 UTC로 저장됨 → 프론트 `parseKST()`로 보정
