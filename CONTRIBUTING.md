# SOOP BJ 공지사항 대시보드 - 협업 가이드

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
```

### Supabase MCP 연결 (선택)
```bash
claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp"
```
재시작 후 Supabase 로그인.

### 로컬 실행
```bash
npx vercel dev --yes
```

---

## 브랜치 전략

### 브랜치 구조
```
master          ← 프로덕션 (Vercel 자동 배포)
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
# master 최신으로 업데이트
git checkout master
git pull origin master

# 브랜치 생성
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
상대방이 먼저 머지했을 수 있으므로, **push 전에 반드시** 최신 master를 내 브랜치에 반영:
```bash
git checkout master
git pull origin master          # 상대방이 머지한 변경사항 가져오기
git checkout feat/내기능
git merge master                # 내 브랜치에 최신 master 반영
```

**충돌이 나면?**
```bash
# 충돌 파일 열어서 수동 해결 (<<<<<<< 마커 찾기)
# 해결 후:
git add <충돌해결한파일>
git commit                      # merge commit 자동 생성
```
같은 파일을 수정했을 때만 충돌 발생. 다른 파일이면 자동 머지됨.

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

# 친구가 먼저 머지함. 이제 내 브랜치는 master보다 뒤처짐
# PR 올리기 전에:
git checkout master && git pull        # 친구 변경사항 가져오기
git checkout feat/검색기능
git merge master                       # 내 브랜치에 반영
# 충돌 없으면 바로 push → PR
```

---

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

### 파일별 역할
| 파일 | 역할 |
|---|---|
| `public/index.html` | 프론트엔드 전체 (HTML+CSS+JS) |
| `api/notices.js` | 공지 목록 API (offset/limit 페이지네이션) |
| `api/notice-content.js` | 개별 공지 본문 API |
| `api/cron/fetch-notices.js` | SOOP → Supabase 수집 (1분마다) |
| `lib/bj-list.js` | BJ 목록 |
| `lib/supabase.js` | Supabase 클라이언트 |
| `vercel.json` | Vercel 설정 + Cron |

### 데이터 흐름
```
SOOP API → [외부 Cron 1분] → Supabase notices 테이블
                                    ↓
                          /api/notices (CDN 60초 캐시)
                                    ↓
                          프론트 (첫 8개 즉시 → 나머지 백그라운드)
```

### Supabase DB 스키마
```sql
notices (
  id            bigserial PK,
  bj_id         text,
  bj_name       text,
  bj_tag        text,
  title_no      bigint UNIQUE,
  title_name    text,
  content_html  text,
  reg_date      timestamptz,  -- KST가 UTC로 저장됨 (프론트에서 보정)
  read_cnt      integer,
  is_pin        boolean,
  updated_at    timestamptz
)
```

---

## 배포

- `master`에 push/머지 → Vercel 자동 배포
- 환경변수: Vercel Dashboard → Settings → Environment Variables
- 외부 Cron: [cron-job.org](https://cron-job.org)에서 1분마다 `/api/cron/fetch-notices` 호출

## 주의사항

- `.env.local`은 절대 커밋 금지
- `master`에 직접 push 금지 → 반드시 PR로
- SOOP API rate limit 주의 — `fetch-notices.js`의 `BATCH_SIZE` 조절
- `reg_date`는 KST인데 DB에 UTC(+00:00)로 저장됨 → 프론트 `parseKST()`로 보정
