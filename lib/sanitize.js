// HTML 정화 — 위험한 태그/속성 제거
function sanitizeHtml(html) {
  if (!html) return "";
  return html
    // script 태그 제거
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // event handler 속성 제거 (onerror, onclick, onload 등)
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    // javascript: URL 제거
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    // data: URL 제거 (이미지 제외)
    .replace(/src\s*=\s*["']data:(?!image\/)[^"']*["']/gi, 'src=""')
    // iframe 제거 (외부 소스)
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    // object, embed, form 태그 제거
    .replace(/<(object|embed|form|input|button|textarea|select)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(object|embed|form|input|button|textarea|select)[^>]*\/?>/gi, "")
    // style 속성에서 expression(), url() 제거
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/style\s*=\s*["'][^"']*url\s*\([^)]*\)[^"']*["']/gi, "");
}

module.exports = { sanitizeHtml };
