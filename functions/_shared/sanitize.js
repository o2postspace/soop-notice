export function sanitizeHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["']data:(?!image\/)[^"']*["']/gi, 'src=""')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<(object|embed|form|input|button|textarea|select)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(object|embed|form|input|button|textarea|select)[^>]*\/?>/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/style\s*=\s*["'][^"']*url\s*\([^)]*\)[^"']*["']/gi, "");
}
