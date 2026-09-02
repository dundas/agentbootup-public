/**
 * Minimal HTML helpers for the server-rendered developer console.
 */

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

export interface HtmlPageOptions {
  /** Allow one caller-provided trusted inline script without relaxing other pages' CSP. */
  scriptNonce?: string;
}

export function htmlPage(title: string, body: string, options: HtmlPageOptions = {}): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #0b1020; color: #e8edf8; }
    main { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p, li { line-height: 1.5; color: #c5cee0; }
    .card { background: #141b31; border: 1px solid #27304a; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
    input, button { font: inherit; }
    input[type="text"], input[type="email"], input[type="password"] {
      width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem;
      border-radius: 8px; border: 1px solid #3a4668; background: #0f1528; color: inherit;
    }
    button, .button {
      display: inline-block; margin-top: 0.75rem; padding: 0.55rem 0.9rem;
      border-radius: 8px; border: 0; background: #4f7cff; color: white; text-decoration: none; cursor: pointer;
    }
    button.secondary, a.secondary { background: #2a3558; }
    button.danger { background: #c44747; }
    .muted { color: #93a0bd; font-size: 0.92rem; }
    .muted-top { margin-top: 1rem; color: #93a0bd; font-size: 0.92rem; }
    form.inline { margin: 0; }
    .secret { font-family: ui-monospace, monospace; word-break: break-all; background: #0f1528; padding: 0.75rem; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.55rem 0.35rem; border-bottom: 1px solid #27304a; vertical-align: top; }
    .status-active { color: #7ddea6; }
    .status-revoked { color: #f0a3a3; }
    nav a { color: #9eb6ff; margin-right: 1rem; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
  const csp = options.scriptNonce
    ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${options.scriptNonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
    : "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': csp,
    },
  });
}
