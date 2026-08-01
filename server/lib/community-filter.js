const DEFAULT_BLOCKED_TERMS = [
  "시발", "씨발", "ㅅㅂ", "병신", "ㅂㅅ", "개새끼", "개색기",
  "ㅆㅂ", "ㅈㄴ", "ㅈㄹ", "ㄴㅇㅁ", "좆", "존나", "지랄",
  "미친놈", "미친년", "창녀", "니애미", "느금마", "엠창", "썅",
];
const DEFAULT_ENGLISH_TERMS = ["fuck", "fucker", "motherfucker", "bitch", "asshole"];
const ENGLISH_OBFUSCATION_SEPARATOR = "[._*~\\-]";

const SUBSTITUTIONS = new Map([
  ["0", "o"], ["1", "i"], ["3", "e"], ["4", "a"], ["5", "s"], ["7", "t"],
]);

function normalizeForFilter(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[013457]/g, character => SUBSTITUTIONS.get(character) || character)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[^\p{L}\p{N}\u3131-\u318E]/gu, "")
    .replace(/(.)\1{1,}/gu, "$1");

  // 일반 명사인 '시발점'은 단독 욕설 '시발' 탐지에서 제외한다.
  return normalized
    .replace(/시발점/g, "출발점")
    .replace(/병신(?:년|일주)/g, "육십갑자");
}

function normalizeKoreanForFilter(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[^\p{Script=Hangul}\u3131-\u318E]/gu, "")
    .replace(/(.)\1{1,}/gu, "$1")
    // 정상 용례가 분명한 합성어·간지 표현은 고신뢰 차단 대상에서 제외한다.
    .replace(/시발점/g, "출발점")
    .replace(/병신(?:년|일주)/g, "육십갑자");
}

function normalizeEnglishForFilter(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  return (normalized.match(/[a-z0-9]+/g) || [])
    .map(token => token
      .replace(/[013457]/g, character => SUBSTITUTIONS.get(character) || character)
      .replace(/[^a-z]/g, "")
      .replace(/(.)\1{1,}/g, "$1"))
    .filter(Boolean);
}

function englishObfuscationPatterns(terms) {
  return terms.map(term => {
    const letters = [...term].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(?:^|[^a-z0-9])${letters.join(`${ENGLISH_OBFUSCATION_SEPARATOR}+`)}(?:$|[^a-z0-9])`, "i");
  });
}

function createProfanityFilter(extraTerms = process.env.COMMUNITY_BLOCKED_WORDS || "") {
  const configured = String(extraTerms)
    .split(",")
    .map(term => normalizeForFilter(term))
    .filter(Boolean);
  const terms = [...new Set([...DEFAULT_BLOCKED_TERMS, ...configured].map(normalizeForFilter))]
    .filter(Boolean);
  const koreanTerms = [...new Set(DEFAULT_BLOCKED_TERMS.map(normalizeKoreanForFilter))].filter(Boolean);
  const englishTerms = new Set(DEFAULT_ENGLISH_TERMS.flatMap(normalizeEnglishForFilter));
  const englishPatterns = englishObfuscationPatterns([...englishTerms]);

  return {
    hasBlockedTerm(value) {
      const normalized = normalizeForFilter(value);
      const korean = normalizeKoreanForFilter(value);
      const englishTokens = normalizeEnglishForFilter(value);
      return terms.some(term => normalized.includes(term))
        || koreanTerms.some(term => korean.includes(term))
        || englishTokens.some(token => englishTerms.has(token))
        || englishPatterns.some(pattern => pattern.test(String(value || "")));
    },
  };
}

module.exports = {
  createProfanityFilter,
  normalizeEnglishForFilter,
  normalizeForFilter,
  normalizeKoreanForFilter,
};
