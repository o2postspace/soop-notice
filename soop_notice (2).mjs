/**
 * SOOP(구 아프리카TV) 대형BJ 공지사항 웹 대시보드
 * 실행: node soop_notice.mjs → 브라우저에서 http://localhost:3000
 */

import http from "http";

// ============================================================
// BJ 목록 - 여기에 추가/삭제 하세요
// ============================================================
// BJ 목록: { 아이디: { name: 이름, tag: 분류 } }
// 분류가 애매하면 여러개 가능 (쉼표로 구분)
const BJ_LIST = {
  phonics1:             { name: "김민교",       tag: "보라" },
  khm11903:             { name: "봉준",         tag: "보라" },
  lshooooo:             { name: "이상호",       tag: "보라" },
  roket0829:            { name: "박퍼니",       tag: "보라" },
  jrdart:               { name: "이지상",       tag: "보라" },
  brainzerg7:           { name: "김윤환",       tag: "스타" },
  devil0108:            { name: "감스트",       tag: "스포츠" },
  y1026:                { name: "철구형2",      tag: "보라" },
  rrvv17:               { name: "킴성태",       tag: "보라" },
  gosegu2:              { name: "고세구",       tag: "왁타버스" },
  ecvhao:               { name: "우왁굳",       tag: "왁타버스" },
  kiss281004:           { name: "피넛",         tag: "롤" },
  ssuperbsw123:         { name: "시조새",       tag: "보라" },
  b13246:               { name: "타요",         tag: "게임" },
  pookygamja:           { name: "김인호",       tag: "보라" },
  yuambo:               { name: "염보성",       tag: "스타" },
  galsa:                { name: "두치와뿌꾸",    tag: "보라" },
  dlghfjs:              { name: "깨박이깨박이",  tag: "보라" },
  freshtomato:          { name: "Fresh토마토",  tag: "여캠" },
  sccha21:              { name: "팡이요",       tag: "메이플" },
  rudals5467:           { name: "이경민",       tag: "스타" },
  jdm1197:              { name: "악어",         tag: "보라" },
  zpdl1313:             { name: "케이",         tag: "보라" },
  rlatldgus:            { name: "오메킴승현",    tag: "보라" },
  viichan6:             { name: "비챤",         tag: "왁타버스" },
  jingburger1:          { name: "징버거",       tag: "왁타버스" },
  tjrdbs999:            { name: "지피티",       tag: "먹방" },
  kymakyma:             { name: "키마",         tag: "하데스" },
  wnnw:                 { name: "남순",         tag: "보라" },
  tntntn13:             { name: "안녕수야",     tag: "보라" },
  rlekfu6:              { name: "박재혁",       tag: "스타" },
  firebathero:          { name: "흑운장TV",     tag: "스타" },
  nangnan:              { name: "깐숙",         tag: "롤" },
  sabread:              { name: "BJ브레드",     tag: "게임" },
  spbabobj:             { name: "머독",         tag: "보라" },
  hwt1014:              { name: "가습기",       tag: "보라" },
  b24ip7:               { name: "민서율",       tag: "여캠" },
  ititit:               { name: "정중만",       tag: "스타" },
  golaniyule0:          { name: "고라니율",     tag: "여캠" },
  legendhyuk:           { name: "오아",         tag: "게임" },
  maoruyakr:            { name: "마왕루야",     tag: "버츄얼" },
  goodb99:              { name: "배그나",       tag: "배그" },
  rud9281:              { name: "한갱",         tag: "여캠" },
  kimdoenmo:            { name: "김된모",       tag: "발로란트" },
  lilpa0309:            { name: "릴파",         tag: "왁타버스" },
  cotton1217:           { name: "주르르",       tag: "왁타버스" },
  tkdduddb06:           { name: "BJ와이퍼",     tag: "스타" },
  eunyoung1238:         { name: "그릴래영",     tag: "여캠" },
  ayanesena:            { name: "아야네세나",    tag: "버츄얼" },
  nanajam:              { name: "우정잉",       tag: "여캠" },
  imhappygood:          { name: "김해피",       tag: "보라" },
  vlfvlf789:            { name: "빵훈이",       tag: "보라" },
  ogm0905:              { name: "오뀨",         tag: "롤" },
  kogo0512:             { name: "수탉",         tag: "게임" },
  cnsgkcnehd74:         { name: "조경훈",       tag: "보라" },
  "243000":             { name: "천양",         tag: "게임" },
  dearhal:              { name: "심청이",       tag: "여캠" },
  mingyeolhee:          { name: "민결희",       tag: "버츄얼" },
  rrrr4719:             { name: "류하",         tag: "여캠" },
  townboy:              { name: "스맵",         tag: "롤" },
  wjswlgns09:           { name: "지두두",       tag: "스타" },
  gofl2237:             { name: "해리",         tag: "왁타버스" },
  qn308dud:             { name: "한둬얼",       tag: "롤" },
  m0m099:               { name: "과즙세연",     tag: "여캠" },
  seemin88:             { name: "비타밍",       tag: "여캠" },
  gjgj3274:             { name: "소룡님",       tag: "보라" },
  dlsn9911:             { name: "제갈금자",     tag: "버츄얼" },
  mj0128:               { name: "백하",         tag: "여캠" },
  ch1716:               { name: "최군형",       tag: "보라" },
  danz59:               { name: "단즈",         tag: "버츄얼" },
  mygomiee:             { name: "마이곰이",     tag: "버츄얼" },
  pyh3646:              { name: "박진우",       tag: "보라" },
  lovely5959:           { name: "수피",         tag: "배그" },
  chaenna02:            { name: "챈나",         tag: "하데스" },
  yeorumi030:           { name: "여르미",       tag: "버츄얼" },
  jaedong23:            { name: "이제동",       tag: "스타" },
  singgyul:             { name: "띵귤",         tag: "하데스" },
  feel0100:             { name: "아리샤",       tag: "여캠" },
  htvv2i:               { name: "햇비",         tag: "버츄얼" },
  joey1114:             { name: "저라뎃",       tag: "롤" },
  danchu17:             { name: "단츄",         tag: "버츄얼" },
  cat123123:            { name: "오리",         tag: "게임" },
  seosils2:             { name: "서실",         tag: "여캠" },
  he0901:               { name: "해기",         tag: "롤" },
  hl6260:               { name: "하리미",       tag: "여캠" },
  pushpull2027:         { name: "이라333",      tag: "메이플" },
  dlqudgk1227:          { name: "병하",         tag: "보라" },
  wnstn0905:            { name: "박사장",       tag: "게임" },
  iamquaddurup:         { name: "장지수",       tag: "보라" },
  "1004ysus":           { name: "둘기얏",       tag: "여캠" },
  momo130:              { name: "김정우",       tag: "스타" },
  hy0325hy:             { name: "애라",         tag: "여캠" },
  kissday621:           { name: "김진솔",       tag: "게임" },
  "120510":             { name: "범프리카",     tag: "보라" },
  hrlim95:              { name: "로기다",       tag: "보라" },
  lhtlgm:               { name: "홍타쿠",       tag: "보라" },
  tiger3006:            { name: "마예준",       tag: "스타" },
  collet11:             { name: "코렛트",       tag: "게임" },
  gudcjf604:            { name: "블랙워크",     tag: "배그" },
  rlrlvkvk123:          { name: "겨우디",       tag: "여캠" },
  rmlrl771:             { name: "끠끼",         tag: "버츄얼" },
  thwl9386:             { name: "지붕위소희",    tag: "게임" },
  whatcherry4:          { name: "연초록",       tag: "하데스" },
  dlrnf:                { name: "유쾌쌍디풍디",  tag: "보라" },
  mooyoomilkkim123:     { name: "김우유",       tag: "여캠" },
  honeys2:              { name: "니니",         tag: "버츄얼" },
  yunhee1222:           { name: "깅예솔",       tag: "여캠" },
  yangdoki:             { name: "양도끼",       tag: "버츄얼" },
  busky3:               { name: "하두링",       tag: "스타" },
  nila25:               { name: "유소나",       tag: "여캠" },
  boong99:              { name: "일루전",       tag: "게임" },
  sky2713:              { name: "나는상윤",     tag: "롤" },
  yjk011599:            { name: "나무늘봉순",    tag: "게임" },
  leesh2148:            { name: "고전파",       tag: "롤" },
  kto9472:              { name: "옥맨",         tag: "롤" },
  nyouuu30810:          { name: "이주하",       tag: "보라" },
  siiyeon:              { name: "애교용",       tag: "게임" },
  kirababy2:            { name: "유키라",       tag: "버츄얼" },
  jhw1729:              { name: "뽀현욱",       tag: "음악" },
  arinbbidol:           { name: "기뉴다",       tag: "스타" },
  nmangoquince:         { name: "망구랑",       tag: "버츄얼" },
  vldpfm2:              { name: "아리송이",     tag: "여캠" },
  dbwls991:             { name: "유진냥",       tag: "여캠" },
  xodud1898:            { name: "태영",         tag: "여캠" },
  dlaguswl501:          { name: "임조이",       tag: "스타" },
  vkzm14:               { name: "중력",         tag: "게임" },
  bach023:              { name: "울산큰고래",    tag: "보라" },
  dkrn56:               { name: "다누리",       tag: "게임" },
  cbn270:               { name: "수찬",         tag: "게임" },
  lunavely4:            { name: "설레나",       tag: "여캠" },
  choi15778:            { name: "도란",         tag: "롤" },
  kanghaera:            { name: "강해라",       tag: "롤" },
  xoals137:             { name: "클리드",       tag: "롤" },
  indy1028:             { name: "안예슬",       tag: "음악" },
  bye1013:              { name: "변현제",       tag: "스타" },
  aksen7833:            { name: "꾸티뉴",       tag: "게임" },
  popoten:              { name: "팥순",         tag: "게임" },
  larothy:              { name: "라로시",       tag: "버츄얼" },
  epsthddus:            { name: "혜루찡",       tag: "여캠" },
  marronie:             { name: "마로니",       tag: "버츄얼" },
  thakzkf:              { name: "짭제다",       tag: "스타" },
  yeopuu:               { name: "여푸",         tag: "여캠" },
  wodnrdldia:           { name: "도재욱",       tag: "스타" },
  smmms2002:            { name: "러아",         tag: "여캠" },
  os3n0o:               { name: "김세노",       tag: "버츄얼" },
  dnwnwjdqhr53:         { name: "설레랑",       tag: "버츄얼" },
  vf3366:               { name: "클로이",       tag: "버츄얼" },
  db001202:             { name: "치리",         tag: "스타" },
  candyrang00:          { name: "하랑",         tag: "롤" },
  yoonesaem:            { name: "윤이샘",       tag: "버츄얼" },
  pig2704:              { name: "프으레이",     tag: "롤" },
  qpqpro:               { name: "디임",         tag: "게임" },
  dobby1031:            { name: "도현",         tag: "게임" },
  insome0319:           { name: "따린",         tag: "버츄얼" },
  h78ert:               { name: "준오",         tag: "스타" },
  cksgmldbs:            { name: "스타급몽군",    tag: "스타" },
  hachi97:              { name: "하치",         tag: "버츄얼" },
  skygkrtn:             { name: "김학수",       tag: "스타" },
  rondobba:             { name: "지동원",       tag: "스타" },
  wannabe33:            { name: "세경",         tag: "여캠" },
  goodzerg:             { name: "배성흠",       tag: "스타" },
  kaksjak0730:          { name: "한결",         tag: "버츄얼" },
  ebfl1818:             { name: "뀨히",         tag: "여캠" },
  e9dongsung:           { name: "이스타추멘",    tag: "스포츠" },
  kubin970515:          { name: "쿠빈",         tag: "보라" },
  evacc7391:            { name: "일하는용형",    tag: "보라" },
  tjdgus3110:           { name: "쪼낙",         tag: "게임" },
  chohw7946:            { name: "조아인",       tag: "여캠" },
  syfan12:              { name: "로자르",       tag: "배그" },
  chanhaee:             { name: "찬해",         tag: "게임" },
  vbvb1230:             { name: "마빡",         tag: "피파" },
  nampil:               { name: "윤시원",       tag: "보라" },
  jgmangnani:           { name: "카라미",       tag: "보라" },
  tjaudtn123:           { name: "서도일",       tag: "롤" },
  under444:             { name: "주보리",       tag: "롤" },
  flower1023:           { name: "김빵귤",       tag: "여캠" },
  wlsgml222:            { name: "서쫑알",       tag: "여캠" },
  jeontaekyu:           { name: "전태규",       tag: "스타" },
  hockey05:             { name: "필메",         tag: "게임" },
  parang1995:           { name: "우니쿤",       tag: "보라" },
  gptn1109:             { name: "킴아연",       tag: "여캠" },
  song:                 { name: "백만송",       tag: "여캠" },
  yjkim5500:            { name: "조디악악악",    tag: "게임" },
  fpahsdltu1:           { name: "주하랑",       tag: "스타" },
  smpk96:               { name: "박삐삐",       tag: "여캠" },
  yoobee22:             { name: "지효",         tag: "여캠" },
  cyzhgw:               { name: "짭구님",       tag: "보라" },
  sdkels:               { name: "강덕구",       tag: "스타" },
  ekdus0830:            { name: "백다연",       tag: "여캠" },
  gksdidqksxn:          { name: "준밧드",       tag: "롤" },
  dadada:               { name: "사이다",       tag: "버츄얼" },
  beadyo97:             { name: "구슬요",       tag: "버츄얼" },
  hs752952:             { name: "완소리",       tag: "여캠" },
  rlaxordyd:            { name: "김택용",       tag: "스타" },
  apple1004l:           { name: "향이",         tag: "여캠" },
  meonjin:              { name: "먼진",         tag: "스타" },
  nanamoon777:          { name: "나나문",       tag: "버츄얼" },
  lcy011027:            { name: "BJ채리",       tag: "여캠" },
  glglehddl:            { name: "타미미",       tag: "여캠" },
  show4006:             { name: "박기봉",       tag: "보라" },
  eunz1nara:            { name: "양팡",         tag: "보라" },
  cc1890:               { name: "BJ피오",       tag: "배그" },
  m2stic:               { name: "진성준짱",     tag: "롤" },
  dbdms139:             { name: "유은",         tag: "여캠" },
  "595935":             { name: "상어녀",       tag: "게임" },
  soju2022:             { name: "소주양",       tag: "여캠" },
  sirianrain:           { name: "시리안레인",    tag: "버츄얼" },
  juju0228:             { name: "미오탱",       tag: "여캠" },
  kmj05317:             { name: "우리밍",       tag: "여캠" },
  wlgua7272:            { name: "2라니",        tag: "스타" },
  dlswldus107:          { name: "인지연",       tag: "여캠" },
  bks1004:              { name: "바카스",       tag: "여캠" },
  ndudska620:           { name: "달그락영주",    tag: "스타" },
  jxbiin:               { name: "쭈빈",         tag: "여캠" },
  kdh:                  { name: "윤콩",         tag: "배그" },
  leetk0410:            { name: "주나",         tag: "보라" },
  jaeparkk:             { name: "박재박",       tag: "보라" },
  qkrgkdms01:           { name: "박하악",       tag: "스타" },
  junghun:              { name: "유봉훈",       tag: "피파" },
  kkok7816:             { name: "서예진",       tag: "여캠" },
  mawang0216:           { name: "마왕",         tag: "버츄얼" },
  wggumteuli:           { name: "꿈틀",         tag: "버츄얼" },
  ambler:               { name: "감블러",       tag: "게임" },
  girlbbo:              { name: "걸뽀",         tag: "배그" },
  bboringirl:           { name: "뽀린걸",       tag: "배그" },
  na2un:                { name: "박나닝",       tag: "게임" },
  aa6232:               { name: "쥐돌이쥐돌이",  tag: "버츄얼" },
  scv6256:              { name: "이재호",       tag: "스타" },
  yus1031:              { name: "유이뿅",       tag: "보라" },
  kimmyungwun:          { name: "명운",         tag: "스타" },
  madaomm:              { name: "마다옴",       tag: "버츄얼" },
  a27bjyngfmh:          { name: "성예린",       tag: "스타" },
  caramel007:           { name: "카라멜",       tag: "버츄얼" },
  sl0724:               { name: "성기사샬롯",    tag: "버츄얼" },
  sm01122:              { name: "불방맹이",     tag: "스포츠" },
  wlswn6565:            { name: "진땅콩",       tag: "게임" },
  eze1017:              { name: "윤이제",       tag: "버츄얼" },
  churros05:            { name: "쮸러스",       tag: "여캠" },
  y970308:              { name: "루루",         tag: "여캠" },
  yeveee:               { name: "유설아",       tag: "버츄얼" },
  hm05082:              { name: "임유진",       tag: "피파" },
  imsofive:             { name: "파이브",       tag: "게임" },
  kyoonah1217:          { name: "소유나",       tag: "여캠" },
  tjdwnls123:           { name: "BJ박성진",     tag: "스타" },
  mm3mmm:               { name: "츄정",         tag: "여캠" },
  bora99:               { name: "구보라",       tag: "여캠" },
  itsme1922:            { name: "메이",         tag: "여캠" },
  gyeonjahee:           { name: "견자희",       tag: "버츄얼" },
  lapq8306:             { name: "눈또",         tag: "여캠" },
  qkfhzhals:            { name: "에스카",       tag: "게임" },
  tleod1818:            { name: "빙밍",         tag: "버츄얼" },
  youchi00:             { name: "유치땅",       tag: "여캠" },
  namyeonhee:           { name: "남연희",       tag: "여캠" },
  sikhye1004:           { name: "거대별",       tag: "버츄얼" },
  goboksu:              { name: "길동92",       tag: "보라" },
  gjstn7637:            { name: "아뚱",         tag: "롤" },
  haneuleee:            { name: "유다인",       tag: "여캠" },
  koreasbg:             { name: "송병구",       tag: "스타" },
  tjdeosks:             { name: "김성대",       tag: "스타" },
  nnnol69:              { name: "아이치",       tag: "게임" },
  rhakdncjs90:          { name: "으냉이",       tag: "스타" },
  gks2wl:               { name: "앵지",         tag: "게임" },
  suhee0051:            { name: "수힛",         tag: "배그" },
  babysoomii:           { name: "한솜비",       tag: "여캠" },
  kimdhun:              { name: "킹기훈",       tag: "보라" },
  zzamta0310:           { name: "짬타수아",     tag: "게임" },
  sigeno230:            { name: "홍이",         tag: "보라" },
  poos69:               { name: "트할",         tag: "롤" },
  wkek1809:             { name: "박프로",       tag: "베그" },
  rumee:                { name: "구루미",       tag: "게임" },
  doorosy:              { name: "오녀리",       tag: "배그" },
  hyeri2244:            { name: "혜리",         tag: "배그" },
  vvelyalwl1047:        { name: "쁠리",         tag: "여캠" },
  beemong:              { name: "비몽",         tag: "버츄얼" },
  eunseo0152:           { name: "은서",         tag: "여캠" },
  nchacha:              { name: "김슬기",       tag: "여캠" },
  yoo376:               { name: "유영진",       tag: "스타" },
  Tenlwlf1:             { name: "ReileyT",     tag: "게임" },
  ksdd7856:             { name: "리하",         tag: "여캠" },
  gpwl4204:             { name: "혜지",         tag: "여캠" },
  spiritzer0:           { name: "스피릿제로",    tag: "게임" },
  afertv:               { name: "ER공식채널",    tag: "게임" },
  gksapdlf:             { name: "한빛",         tag: "여캠" },
  dodenvoa:             { name: "마꼬",         tag: "여캠" },
  rlantnghks:           { name: "페이즈",       tag: "롤" },
  ansguswns519:         { name: "onerrrr",     tag: "롤" },
  "1004suna":           { name: "임아니",       tag: "게임" },
  zkwks4413:            { name: "꿀탱탱",       tag: "게임" },
  gkdlqk13:             { name: "김동하",       tag: "롤" },
  ckmin706:             { name: "민찬기",       tag: "스타" },
  gine7777:             { name: "킥갓",         tag: "게임" },
  ho1godme:             { name: "김지성",       tag: "스타" },
};

const PORT = 4000;
const API_URL = "https://chapi.sooplive.co.kr/api/{bj_id}/home";
const POST_API_URL = "https://api-channel.sooplive.co.kr/v1.1/channel/{bj_id}/post/{title_no}";
const HEADERS = {
  Referer: "https://www.sooplive.co.kr/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

async function fetchNotices(bjId) {
  try {
    const url = API_URL.replace("{bj_id}", bjId);
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const boards = data.boards || [];
    return boards.filter((b) => b.is_notice);
  } catch (e) {
    return [];
  }
}

// 개별 공지 상세 본문 HTML 가져오기
async function fetchPostContent(bjId, titleNo) {
  try {
    const url = POST_API_URL.replace("{bj_id}", bjId).replace("{title_no}", titleNo);
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data.content?.content || "";
  } catch (e) {
    return "";
  }
}

async function fetchAllNotices() {
  const results = {};
  const promises = Object.entries(BJ_LIST).map(async ([bjId, info]) => {
    const notices = await fetchNotices(bjId);

    // 각 공지의 본문 HTML을 병렬로 가져옴
    const noticesWithContent = await Promise.all(
      notices.map(async (n) => {
        const contentHtml = await fetchPostContent(bjId, n.title_no);
        return { ...n, contentHtml };
      })
    );

    results[bjId] = { name: info.name, tag: info.tag, notices: noticesWithContent };
  });
  await Promise.all(promises);
  return results;
}

// 태그 목록 추출
const ALL_TAGS = [...new Set(Object.values(BJ_LIST).map(v => v.tag))];

function getHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SOOP BJ 공지사항</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    font-family: 'Segoe UI', -apple-system, 'Malgun Gothic', sans-serif;
    background: #f5f5f5;
    color: #222;
    height: 100%;
    overflow: hidden;
  }
  header {
    background: #fff;
    padding: 14px 24px;
    border-bottom: 1px solid #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 100;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    flex-shrink: 0;
  }
  header h1 { font-size: 18px; color: #222; font-weight: 700; }
  header h1 span { color: #5B6AED; }
  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  #lastUpdate { font-size: 12px; color: #999; }
  #refreshBtn {
    background: #5B6AED;
    color: #fff;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
  }
  #refreshBtn:hover { background: #4a58d4; }
  #refreshBtn:disabled { opacity: 0.5; cursor: not-allowed; }
  .auto-refresh {
    display: flex; align-items: center; gap: 5px;
    font-size: 12px; color: #999;
  }
  .auto-refresh select {
    background: #fff; color: #333;
    border: 1px solid #ddd; padding: 3px 6px;
    border-radius: 4px; font-size: 11px;
  }

  /* 필터 바 */
  .filter-bar {
    background: #fff;
    padding: 10px 24px;
    border-bottom: 1px solid #eee;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    z-index: 99;
    flex-shrink: 0;
  }
  .filter-bar .label { font-size: 12px; color: #999; margin-right: 4px; }
  .filter-btn {
    padding: 4px 12px;
    border-radius: 14px;
    border: 1px solid #ddd;
    background: transparent;
    color: #666;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: #5B6AED; color: #5B6AED; }
  .filter-btn.active { background: #5B6AED; color: #fff; border-color: #5B6AED; font-weight: 600; }
  .filter-btn.fav { border-color: #ff6b6b; }
  .filter-btn.fav.active { background: #ff6b6b; color: #fff; border-color: #ff6b6b; }
  .divider { width: 1px; height: 18px; background: #ddd; margin: 0 4px; }
  .edit-fav-btn {
    padding: 4px 10px;
    border-radius: 14px;
    border: 1px dashed #ccc;
    background: transparent;
    color: #999;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .edit-fav-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }
  .filter-btn.tag { border-color: #a29bfe; }
  .filter-btn.tag.active { background: #a29bfe; color: #fff; border-color: #a29bfe; }

  /* 전체 레이아웃 */
  .app-wrap {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* 페이지 컨테이너 */
  .page-scroller {
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  /* 각 페이지 */
  .page {
    display: none;
    height: 100%;
    overflow-y: auto;
    padding: 20px 16px;
    justify-content: center;
  }
  .page.active {
    display: flex;
    animation: pageFadeIn 0.3s ease;
  }
  @keyframes pageFadeIn {
    from { opacity: 0; transform: translateY(30px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .page-inner {
    max-width: 1400px;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    align-items: start;
    align-content: start;
  }

  .card {
    background: #fff;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    transition: box-shadow 0.2s, transform 0.2s;
    cursor: pointer;
  }
  .card:hover {
    box-shadow: 0 6px 20px rgba(0,0,0,0.12);
    transform: translateY(-2px);
  }
  .card.hidden { display: none; }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #f0f0f0;
  }
  .card-name {
    font-weight: 700;
    font-size: 13px;
    color: #5B6AED;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-tag {
    font-size: 10px;
    color: #a29bfe;
    border: 1px solid #d5d0ff;
    padding: 1px 7px;
    border-radius: 10px;
    font-weight: 500;
    background: #f5f3ff;
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: 8px;
  }
  .card-content {
    padding: 12px 14px;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    color: #333;
    line-height: 1.5;
    margin-bottom: 6px;
    word-break: break-word;
  }
  .card-title .pin { color: #ff6b6b; margin-right: 3px; font-size: 10px; }
  .card-title .new-badge {
    background: #ff4757; color: #fff;
    font-size: 9px; padding: 1px 4px;
    border-radius: 3px; margin-left: 4px; font-weight: bold;
    vertical-align: middle;
  }
  .card-meta {
    font-size: 11px; color: #aaa;
    display: flex; gap: 10px;
    margin-bottom: 8px;
  }
  /* 공지 본문 영역 - 접힘 */
  .card-body {
    font-size: 13px;
    line-height: 1.7;
    color: #444;
    overflow: hidden;
    word-break: break-word;
    max-height: 150px;
    position: relative;
    transition: max-height 0.3s ease;
  }
  .card-body.expanded {
    max-height: none;
  }
  .card-body:not(.expanded)::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(transparent, #fff);
    pointer-events: none;
  }
  .card-expand-btn {
    display: none;
    width: 100%;
    padding: 6px 0;
    border: none;
    background: #f8f8ff;
    color: #5B6AED;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border-top: 1px solid #f0f0f0;
    transition: background 0.15s;
  }
  .card-expand-btn:hover { background: #eef0ff; }
  .card-expand-btn.visible { display: block; }
  .card-body img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 6px 0;
    display: block;
  }
  .card-body br + br { display: none; }
  .card-body a { color: #5B6AED; }
  .card-body iframe, .card-body video {
    max-width: 100%;
    border-radius: 6px;
    margin: 6px 0;
  }

  @media (max-width: 1200px) { .page-inner { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 900px) { .page-inner { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 550px) { .page-inner { grid-template-columns: 1fr; } }

  .loading {
    display: flex; align-items: center; justify-content: center;
    padding: 60px; color: #5B6AED; font-size: 14px;
  }
  .loading .spinner {
    width: 20px; height: 20px;
    border: 3px solid #e0e0e0;
    border-top: 3px solid #5B6AED;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 10px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-msg {
    text-align: center; padding: 40px; color: #bbb; font-size: 13px;
    background: #fff; border-radius: 10px;
  }

  .toast {
    position: fixed; bottom: 20px; right: 20px;
    background: #fff; border: 1px solid #5B6AED;
    color: #5B6AED; padding: 10px 18px;
    border-radius: 8px; font-size: 13px;
    transform: translateY(80px); opacity: 0;
    transition: all 0.3s; z-index: 200;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  }

  /* 쇼츠 스타일 네비게이션 버튼 */
  .scroll-nav {
    position: fixed;
    right: 24px;
    bottom: 50%;
    transform: translateY(50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    z-index: 150;
  }
  .scroll-nav button {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: none;
    background: #fff;
    color: #5B6AED;
    font-size: 22px;
    cursor: pointer;
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .scroll-nav button:hover {
    background: #5B6AED;
    color: #fff;
    transform: scale(1.1);
  }
  .scroll-nav button:active {
    transform: scale(0.95);
  }
  .scroll-nav button:disabled {
    opacity: 0.3;
    cursor: default;
    transform: none;
  }
  .scroll-nav button:disabled:hover {
    background: #fff;
    color: #5B6AED;
  }
  .scroll-nav .nav-counter {
    text-align: center;
    font-size: 11px;
    color: #666;
    font-weight: 600;
    line-height: 1.2;
    user-select: none;
    background: #fff;
    padding: 4px 8px;
    border-radius: 10px;
    box-shadow: 0 1px 6px rgba(0,0,0,0.1);
  }
  .toast.show { transform: translateY(0); opacity: 1; }

  /* 본진 편집 모달 */
  .modal-bg {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.3);
    z-index: 300;
    align-items: center; justify-content: center;
  }
  .modal-bg.show { display: flex; }
  .modal {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
    max-height: 70vh;
    overflow-y: auto;
    box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  }
  .modal-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .modal h3 { color: #222; font-size: 16px; }
  .modal-close {
    width: 28px; height: 28px;
    border: 1px solid #ddd; border-radius: 6px;
    background: transparent; color: #999;
    font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .modal-close:hover { border-color: #ff6b6b; color: #ff6b6b; }
  .modal-bj {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 0; border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
  }
  .modal-bj:hover { background: #f8f8ff; }
  .modal-bj .check {
    width: 20px; height: 20px;
    border: 2px solid #ddd; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: transparent; transition: all 0.15s;
  }
  .modal-bj .check.on { border-color: #ff6b6b; color: #ff6b6b; background: rgba(255,107,107,0.08); }
  .modal-bj span { font-size: 13px; color: #333; }
  .modal-actions {
    display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end;
  }
  .modal-actions button {
    padding: 8px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; border: none;
  }
  .btn-save { background: #5B6AED; color: #fff; font-weight: 600; }
  .btn-cancel { background: #eee; color: #666; }

  @media (max-width: 600px) {
    .page { padding: 10px 8px; }
    header { padding: 10px 14px; flex-wrap: wrap; gap: 8px; }
    .filter-bar { padding: 8px 14px; }
    .scroll-nav { right: 12px; }
    .scroll-nav button { width: 40px; height: 40px; font-size: 18px; }
  }
</style>
</head>
<body>
<div class="app-wrap">

<header>
  <h1><span>SOOP</span> BJ 공지사항</h1>
  <div class="header-right">
    <div class="auto-refresh">
      자동갱신
      <select id="intervalSelect">
        <option value="0">끄기</option>
        <option value="30">30초</option>
        <option value="60" selected>1분</option>
        <option value="180">3분</option>
      </select>
    </div>
    <span id="lastUpdate"></span>
    <button id="refreshBtn" onclick="loadAll()">새로고침</button>
  </div>
</header>

<div class="filter-bar" id="filterBar">
  <span class="label">필터</span>
  <button class="filter-btn fav" data-filter="fav" onclick="setFilter('fav')">본진</button>
  <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">전체</button>
  <div class="divider"></div>
  ${ALL_TAGS.map(t => `<button class="filter-btn tag" data-filter="tag:${t}" onclick="setFilter('tag:${t}')">${t}</button>`).join('\n  ')}
  <div class="divider"></div>
  <button class="edit-fav-btn" onclick="openModal()">본진 설정</button>
</div>

<div class="page-scroller" id="scroller">
  <div id="container">
    <div class="loading">
      <div class="spinner"></div> 불러오는 중...
    </div>
  </div>
</div>

</div><!-- app-wrap -->

<div class="toast" id="toast"></div>

<!-- 쇼츠 스타일 페이지 네비게이션 -->
<div class="scroll-nav" id="scrollNav" style="display:none;">
  <button id="btnPrev" onclick="goPage(-1)" title="이전 페이지">▲</button>
  <div class="nav-counter" id="navCounter"></div>
  <button id="btnNext" onclick="goPage(1)" title="다음 페이지">▼</button>
</div>

<!-- 본진 설정 모달 -->
<div class="modal-bg" id="modalBg">
  <div class="modal">
    <div class="modal-top">
      <h3>본진 BJ 설정</h3>
      <button class="modal-close" onclick="closeModal()">X</button>
    </div>
    <div id="modalList"></div>
    <div class="modal-actions">
      <button class="btn-save" onclick="saveFav()">저장</button>
    </div>
  </div>
</div>

<script>
const BJ_LIST = ${JSON.stringify(BJ_LIST)};
const ALL_TAGS = ${JSON.stringify(ALL_TAGS)};
let prevData = {};
let autoTimer = null;
let currentFilter = 'all';
let favorites = JSON.parse(localStorage.getItem('soop_fav') || '[]');
let tempFav = [];

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return m + "분 전";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "시간 전";
  const d = Math.floor(h / 24);
  return d + "일 전";
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  return mm+'.'+dd+' '+hh+':'+mi;
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function isNew(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) < 3 * 3600000;
}

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// 필터
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.filter-btn[data-filter="'+f+'"]').classList.add('active');
  applyFilter();
}

function applyFilter() {
  // 필터 변경 시 페이지를 다시 렌더링
  if (Object.keys(prevData).length > 0) {
    renderPages(prevData);
  }
}

// 본진 모달
function openModal() {
  tempFav = [...favorites];
  const list = document.getElementById('modalList');
  list.innerHTML = '';
  for (const [id, info] of Object.entries(BJ_LIST)) {
    const on = tempFav.includes(id) ? 'on' : '';
    const name = info.name || info;
    const tag = info.tag || '';
    list.innerHTML += '<div class="modal-bj" onclick="toggleFav(this,\\''+id+'\\')"><div class="check '+on+'">V</div><span>'+escapeHtml(name)+' <small style="color:#999;font-size:11px">'+escapeHtml(tag)+'</small></span></div>';
  }
  document.getElementById('modalBg').classList.add('show');
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'modalBg') closeModal();
});

function closeModal() {
  document.getElementById('modalBg').classList.remove('show');
}

function toggleFav(el, id) {
  const check = el.querySelector('.check');
  if (tempFav.includes(id)) {
    tempFav = tempFav.filter(x => x !== id);
    check.classList.remove('on');
  } else {
    tempFav.push(id);
    check.classList.add('on');
  }
}

function saveFav() {
  favorites = [...tempFav];
  localStorage.setItem('soop_fav', JSON.stringify(favorites));
  closeModal();
  applyFilter();
  showToast("본진 저장 완료!");
}

// 카드 HTML 생성
function buildCardHtml(item) {
  const n = item.notice;
  const pin = n.is_pin ? '<span class="pin">PIN</span>' : '';
  const newBadge = isNew(n.reg_date) ? '<span class="new-badge">N</span>' : '';
  const reads = n.count?.read_cnt?.toLocaleString() || '0';
  const tagBadge = item.tag ? '<span class="card-tag">' + escapeHtml(item.tag) + '</span>' : '';
  const bodyHtml = n.contentHtml || '';

  return '<div class="card" data-bjid="' + item.bjId + '">'
    + '<div class="card-header">'
    + '<span class="card-name">' + escapeHtml(item.name) + '</span>'
    + tagBadge
    + '</div>'
    + '<div class="card-content">'
    + '<div class="card-title">' + pin + escapeHtml(n.title_name || '') + newBadge + '</div>'
    + '<div class="card-meta">'
    + '<span>' + formatDate(n.reg_date) + '</span>'
    + '<span>' + timeAgo(n.reg_date) + '</span>'
    + '<span>조회 ' + reads + '</span>'
    + '</div>'
    + (bodyHtml ? '<div class="card-body">' + bodyHtml + '</div>'
      + '<button class="card-expand-btn" onclick="toggleExpand(event, this)">더보기</button>' : '')
    + '</div>'
    + '</div>';
}

// 한 페이지당 카드 수 (최대 8개)
function getCardsPerPage() {
  return 4;
}

let currentPage = 0;
let totalPages = 0;
let filteredNotices = [];

// 필터 적용 후 공지 목록 생성
function getFilteredNotices(data) {
  const allNotices = [];
  for (const [bjId, info] of Object.entries(data)) {
    for (const n of info.notices) {
      allNotices.push({ bjId, name: info.name, tag: info.tag, notice: n });
    }
  }
  allNotices.sort((a, b) => new Date(b.notice.reg_date) - new Date(a.notice.reg_date));

  if (currentFilter === 'all') return allNotices;
  if (currentFilter === 'fav') return allNotices.filter(x => favorites.includes(x.bjId));
  if (currentFilter.startsWith('tag:')) {
    const tag = currentFilter.slice(4);
    return allNotices.filter(x => x.tag === tag);
  }
  return allNotices;
}

// 페이지 단위로 렌더링
function renderPages(data) {
  filteredNotices = getFilteredNotices(data);
  const perPage = getCardsPerPage();
  totalPages = Math.max(1, Math.ceil(filteredNotices.length / perPage));
  currentPage = Math.min(currentPage, totalPages - 1);

  const container = document.getElementById('container');

  if (filteredNotices.length === 0) {
    container.innerHTML = '<div class="page"><div class="empty-msg">공지가 없습니다</div></div>';
    document.getElementById('scrollNav').style.display = 'none';
    return;
  }

  let html = '';
  for (let p = 0; p < totalPages; p++) {
    const start = p * perPage;
    const end = Math.min(start + perPage, filteredNotices.length);
    html += '<div class="page" data-page="' + p + '"><div class="page-inner">';
    for (let i = start; i < end; i++) {
      html += buildCardHtml(filteredNotices[i]);
    }
    html += '</div></div>';
  }
  container.innerHTML = html;

  // 긴 본문에만 "더보기" 버튼 표시
  container.querySelectorAll('.card-body').forEach(body => {
    if (body.scrollHeight > 160) {
      const btn = body.nextElementSibling;
      if (btn && btn.classList.contains('card-expand-btn')) {
        btn.classList.add('visible');
      }
    }
  });

  // 현재 페이지 표시
  showCurrentPage();
  document.getElementById('scrollNav').style.display = 'flex';
}

function toggleExpand(e, btn) {
  e.stopPropagation();
  const body = btn.previousElementSibling;
  const expanded = body.classList.toggle('expanded');
  btn.textContent = expanded ? '접기' : '더보기';
}

function goPage(dir) {
  const next = currentPage + dir;
  if (next < 0 || next >= totalPages) return;
  currentPage = next;
  showCurrentPage();
}

function showCurrentPage() {
  const pages = document.querySelectorAll('#container .page');
  pages.forEach((p, i) => {
    p.classList.toggle('active', i === currentPage);
  });
  updateNav();
}

function updateNav() {
  document.getElementById('navCounter').textContent = (currentPage + 1) + ' / ' + totalPages;
  document.getElementById('btnPrev').disabled = (currentPage <= 0);
  document.getElementById('btnNext').disabled = (currentPage >= totalPages - 1);
}

// 키보드: 위/아래, j/k, PageUp/PageDown
document.addEventListener('keydown', (e) => {
  if (document.getElementById('modalBg').classList.contains('show')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    goPage(1);
  } else if (e.key === 'k' || e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    goPage(-1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    currentPage = 0;
    showCurrentPage();
  } else if (e.key === 'End') {
    e.preventDefault();
    currentPage = totalPages - 1;
    showCurrentPage();
  }
});

// 마우스 휠로 페이지 전환
document.addEventListener('DOMContentLoaded', () => {
  let wheelLock = false;
  document.addEventListener('wheel', (e) => {
    if (document.getElementById('modalBg').classList.contains('show')) return;
    e.preventDefault();
    if (wheelLock) return;
    wheelLock = true;
    if (e.deltaY > 0) goPage(1);
    else if (e.deltaY < 0) goPage(-1);
    setTimeout(() => { wheelLock = false; }, 400);
  }, { passive: false });
});

// 리사이즈 시 페이지 재구성
window.addEventListener('resize', () => {
  if (Object.keys(prevData).length > 0) {
    renderPages(prevData);
  }
});

async function loadAll() {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "...";

  try {
    const resp = await fetch("/api/notices");
    const data = await resp.json();

    let newCount = 0;
    for (const bjId in data) {
      const oldIds = (prevData[bjId]?.notices || []).map(n => n.title_no);
      for (const n of data[bjId].notices) {
        if (oldIds.length > 0 && !oldIds.includes(n.title_no)) newCount++;
      }
    }
    if (newCount > 0) showToast("새 공지 " + newCount + "개!");

    prevData = data;
    currentPage = 0;
    renderPages(data);

    document.getElementById("lastUpdate").textContent =
      new Date().toLocaleTimeString("ko-KR");
  } catch(e) {
    showToast("실패: " + e.message);
  }

  btn.disabled = false;
  btn.textContent = "새로고침";
}

function setupAutoRefresh() {
  const sel = document.getElementById("intervalSelect");
  sel.addEventListener("change", () => {
    if (autoTimer) clearInterval(autoTimer);
    const sec = parseInt(sel.value);
    if (sec > 0) autoTimer = setInterval(loadAll, sec * 1000);
  });
  autoTimer = setInterval(loadAll, 60000);
}

loadAll();
setupAutoRefresh();
</script>
</body>
</html>`;
}

// ============================================================
// HTTP 서버
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.url === "/api/notices") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    const data = await fetchAllNotices();
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getHTML());
  }
});

server.listen(PORT, () => {
  console.log(`\n  SOOP BJ 공지사항 대시보드 실행 중!`);
  console.log(`  ➜ http://localhost:${PORT}`);
  console.log(`  종료: Ctrl+C\n`);

  import("child_process").then(({ exec }) => {
    exec(`start http://localhost:${PORT}`);
  });
});
