// Kept in its own module so splash.ts can escape without importing layout.ts,
// which imports splash.ts back. Re-exported from layout.ts, so existing
// `import { esc } from '../views/layout'` call sites are unaffected.
export const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
