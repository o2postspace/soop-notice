# SOOP BJ 공지사항 대시보드

## 프로젝트 개요
SOOP(구 아프리카TV) BJ들의 공지사항을 한 곳에서 모아보는 웹 대시보드.
Vercel + Supabase로 배포.

## 기술 스택
- **프론트엔드**: 순수 HTML/CSS/JS (public/index.html)
- **백엔드**: Vercel Serverless Functions (api/)
- **DB**: Supabase (PostgreSQL)
- **배포**: Vercel (GitHub 연동)

## 프로젝트 구조
```
afreecanotice/
├── public/
│   └── index.html          # 프론트엔드 (정적 파일)
├── api/
│   ├── notices.js           # GET /api/notices - Supabase에서 공지 읽기
│   └── cron/
│       └── fetch-notices.js # Cron Job - SOOP API → Supabase 저장 (1분마다)
├── lib/
│   ├── bj-list.js           # BJ 목록 (아이디, 이름, 태그)
│   └── supabase.js          # Supabase 클라이언트
├── vercel.json              # Vercel 설정 + Cron 스케줄
├── package.json
├── .env.local               # 환경변수 (커밋 금지)
├── .gitignore
├── supabase-schema.sql      # DB 테이블 생성 SQL
└── soop_notice (2).mjs      # 기존 로컬 버전 (레거시, 참고용)
```

## 데이터 흐름
1. Vercel Cron이 1분마다 `/api/cron/fetch-notices` 호출
2. SOOP API에서 각 BJ의 공지사항 + 본문 수집
3. Supabase `notices` 테이블에 upsert (title_no 기준)
4. 유저가 사이트 접속하면 `/api/notices`가 Supabase에서 읽어서 응답
5. 응답에 CDN 캐시 적용 (60초 + stale-while-revalidate 120초)

## BJ 추가/삭제
- `lib/bj-list.js`의 `BJ_LIST` 객체에 추가/삭제
- 형식: `아이디: { name: "이름", tag: "분류" }`
- 숫자로 시작하는 아이디는 따옴표 필요: `"1004ysus": { ... }`

## 태그 분류
보라, 스타, 롤, 여캠, 왁타버스, 게임, 버츄얼, 배그, 먹방, 하데스, 메이플, 스포츠, 음악, 피파, 발로란트, 뉴스

## 환경변수
- `SUPABASE_URL`: Supabase 프로젝트 URL
- `SUPABASE_ANON_KEY`: Supabase anon public key
- `CRON_SECRET`: Cron Job 인증용 시크릿 (Vercel에서 자동 설정)

## 로컬 개발
```bash
npm install
# .env.local에 환경변수 설정 후
npx vercel dev
```

## 주의사항
- `.env.local`은 절대 커밋하지 않기
- SOOP API는 rate limit이 있으므로 BJ 수가 많으면 배치 크기(BATCH_SIZE) 조절
- Vercel Cron은 Pro 플랜에서만 1분 간격 가능, Hobby는 최소 1일 간격
