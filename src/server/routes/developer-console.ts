/**
 * Server-rendered developer console (PRD-0041 FR-4, OQ-3).
 *
 * Page map:
 *   GET  /developer                 — onboarding / redirect
 *   GET  /developer/login           — sign-in entry (JSON-posts to /auth/login)
 *   GET  /developer/register        — registration entry (JSON-posts to /auth/register)
 *   GET  /developer/keys            — active keys + create form
 *   POST /developer/keys            — create key (one-time secret via flash)
 *   POST /developer/keys/:id/revoke — revoke key
 *   GET  /developer/device            — approve CLI device login (user_code query param)
 *   POST /developer/device/approve  — approve CLI device login
 */

import { randomBytes } from 'node:crypto';
import { HttpError, methodNotAllowed, ensureString } from '../errors';
import { escapeHtml, htmlPage } from '../lib/html-response';
import type { ExternalKeyService } from '../lib/external-key-service';
import type { DeviceAuthStore } from '../lib/device-auth-store';
import type { ConsoleEphemeralStore } from '../lib/console-ephemeral-store';
import {
  redirectToLogin,
  resolveHostedExternalUser,
  sanitizeDeveloperReturnPath,
  type DeveloperSessionDeps,
} from '../lib/developer-session';

export interface DeveloperConsoleRouteDeps extends DeveloperSessionDeps {
  keyService: ExternalKeyService;
  deviceAuthStore: DeviceAuthStore;
  ephemeralStore: ConsoleEphemeralStore;
  publicBaseUrl: string;
  maxActiveKeys: number;
}

function nav(publicBaseUrl: string): string {
  return `<nav>
    <a href="${escapeHtml(publicBaseUrl)}/developer">Home</a>
    <a href="${escapeHtml(publicBaseUrl)}/developer/keys">API Keys</a>
    <a href="${escapeHtml(publicBaseUrl)}/auth/logout">Sign out</a>
  </nav>`;
}

function formatTs(value: string | null): string {
  if (!value) return '—';
  return escapeHtml(value);
}

function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(token)}" />`;
}

/**
 * ClearAuth deliberately accepts JSON only. Keep the browser form transport
 * here, rather than relying on HTML's urlencoded default or exposing its
 * registration API as a GET route.
 */
function credentialsForm(input: {
  id: string;
  endpoint: '/auth/login' | '/auth/register';
  submitLabel: string;
  passwordAutocomplete: 'current-password' | 'new-password';
  returnPath: string;
  scriptNonce: string;
}): string {
  return `<form id="${input.id}" data-auth-endpoint="${input.endpoint}" data-return-path="${escapeHtml(input.returnPath)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="${input.passwordAutocomplete}" required />
      <p class="status-revoked" data-auth-error hidden></p>
      <button type="submit">${input.submitLabel}</button>
    </form>
    <script nonce="${escapeHtml(input.scriptNonce)}">
      (() => {
        const form = document.getElementById(${JSON.stringify(input.id)});
        if (!(form instanceof HTMLFormElement)) return;
        const error = form.querySelector('[data-auth-error]');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!(error instanceof HTMLElement)) return;
          error.hidden = true;
          try {
            const response = await fetch(form.dataset.authEndpoint || '', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: String(new FormData(form).get('email') || ''),
                password: String(new FormData(form).get('password') || ''),
              }),
            });
            if (!response.ok) {
              const body = await response.json().catch(() => null);
              error.textContent = typeof body?.error === 'string' ? body.error : 'Unable to complete authentication.';
              error.hidden = false;
              return;
            }
            window.location.assign(form.dataset.returnPath || '/developer');
          } catch {
            error.textContent = 'Unable to complete authentication.';
            error.hidden = false;
          }
        });
      })();
    </script>`;
}

const CONSOLE_ERROR_MESSAGES: Record<string, string> = {
  limit_exceeded: 'You already have the maximum number of active API keys. Revoke one before creating another.',
  csrf_invalid: 'Your session expired or the form was invalid. Please try again.',
};

function consoleErrorBanner(errorCode: string | null): string {
  if (!errorCode) return '';
  const message = CONSOLE_ERROR_MESSAGES[errorCode];
  if (!message) return '';
  return `<div class="card"><p class="status-revoked">${escapeHtml(message)}</p></div>`;
}

/** Map HttpError to HTML/redirect for browser console routes (used by server.ts catch). */
export function translateDeveloperConsoleHttpError(
  err: HttpError,
  publicBaseUrl: string,
  path: string,
): Response | null {
  if (path !== '/developer' && !path.startsWith('/developer/')) return null;

  if (err.code === 'limit_exceeded') {
    return Response.redirect(`${publicBaseUrl}/developer/keys?error=limit_exceeded`, 302);
  }
  if (err.code === 'forbidden' && err.message.includes('CSRF')) {
    const target = path.startsWith('/developer/device') ? '/developer/device' : '/developer/keys';
    return Response.redirect(`${publicBaseUrl}${target}?error=csrf_invalid`, 302);
  }

  const body = `${nav(publicBaseUrl)}
    <h1>Something went wrong</h1>
    <div class="card"><p class="muted">${escapeHtml(err.message)}</p></div>
    <a class="button" href="${escapeHtml(publicBaseUrl)}/developer">Back to console</a>`;
  return htmlPage('Error', body);
}

async function readValidatedForm(
  req: Request,
  userId: string,
  deps: DeveloperConsoleRouteDeps,
): Promise<FormData> {
  const form = await req.formData();
  const token = String(form.get('csrf_token') ?? '');
  await deps.ephemeralStore.validateCsrfToken(userId, token);
  return form;
}

export async function handleDeveloperConsoleRoute(
  req: Request,
  method: string,
  path: string,
  deps: DeveloperConsoleRouteDeps,
): Promise<Response | null> {
  if (path !== '/developer' && !path.startsWith('/developer/')) return null;

  if (path === '/developer') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return redirectToLogin(deps.publicBaseUrl, '/developer');
    const body = `${nav(deps.publicBaseUrl)}
      <h1>Developer Console</h1>
      <div class="card">
        <p>Signed in as <strong>${escapeHtml(resolved.externalUser.email)}</strong>.</p>
        <p>Dashboard login is for humans. API access uses personal bearer keys — create one, copy it once, then use it from the CLI, SDK, or direct HTTP.</p>
        <p class="muted">External keys only work on the published public allowlist (for example <code>GET /v1/auth/status</code> and read-only registry routes).</p>
        <a class="button" href="${escapeHtml(deps.publicBaseUrl)}/developer/keys">Manage API keys</a>
      </div>`;
    return htmlPage('Developer Console', body);
  }

  if (path === '/developer/login') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const url = new URL(req.url);
    const returnPath = sanitizeDeveloperReturnPath(url.searchParams.get('return') || '/developer');
    const registrationUrl = new URL('/developer/register', deps.publicBaseUrl);
    registrationUrl.searchParams.set('return', returnPath);
    const scriptNonce = randomBytes(18).toString('base64url');
    const body = `${nav(deps.publicBaseUrl)}
      <h1>Sign in</h1>
      <div class="card">
        <p class="muted">Use your ClearAuth account to access the developer console.</p>
        ${credentialsForm({ id: 'developer-login', endpoint: '/auth/login', submitLabel: 'Sign in', passwordAutocomplete: 'current-password', returnPath, scriptNonce })}
        <p class="muted-top">No account yet? <a href="${escapeHtml(registrationUrl.toString())}">Create one</a>.</p>
      </div>`;
    return htmlPage('Sign in', body, { scriptNonce });
  }

  if (path === '/developer/register') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const url = new URL(req.url);
    const returnPath = sanitizeDeveloperReturnPath(url.searchParams.get('return') || '/developer');
    const loginUrl = new URL('/developer/login', deps.publicBaseUrl);
    loginUrl.searchParams.set('return', returnPath);
    const scriptNonce = randomBytes(18).toString('base64url');
    const body = `${nav(deps.publicBaseUrl)}
      <h1>Create account</h1>
      <div class="card">
        <p class="muted">Create a ClearAuth account, then manage your personal API keys from the developer console.</p>
        ${credentialsForm({ id: 'developer-register', endpoint: '/auth/register', submitLabel: 'Create account', passwordAutocomplete: 'new-password', returnPath, scriptNonce })}
        <p class="muted-top">Already have an account? <a href="${escapeHtml(loginUrl.toString())}">Sign in</a>.</p>
      </div>`;
    return htmlPage('Create account', body, { scriptNonce });
  }

  if (path === '/developer/keys' && method === 'POST') {
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return redirectToLogin(deps.publicBaseUrl, '/developer/keys');
    const form = await readValidatedForm(req, resolved.externalUser.id, deps);
    let label: string;
    try {
      label = ensureString(form.get('label') ?? '', 'label', { maxLength: 120 });
    } catch {
      return Response.redirect(`${deps.publicBaseUrl}/developer/keys`, 302);
    }
    const created = await deps.keyService.createForUser(resolved.externalUser.id, label);
    const flashId = await deps.ephemeralStore.createFlashSecret(
      resolved.externalUser.id,
      created.secret,
      created.key.label,
    );
    const redirectUrl = new URL('/developer/keys', deps.publicBaseUrl);
    redirectUrl.searchParams.set('flash', flashId);
    return Response.redirect(redirectUrl.toString(), 302);
  }

  if (path === '/developer/keys') {
    if (method !== 'GET') return methodNotAllowed(['GET', 'POST']);
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return redirectToLogin(deps.publicBaseUrl, '/developer/keys');

    const url = new URL(req.url);
    const errorCode = url.searchParams.get('error');
    await deps.ephemeralStore.purgeExpiredNow();
    const flashId = url.searchParams.get('flash');
    const flashed = flashId
      ? await deps.ephemeralStore.consumeFlashSecret(resolved.externalUser.id, flashId, { skipPurge: true })
      : null;
    const csrfToken = await deps.ephemeralStore.issueCsrfToken(
      resolved.externalUser.id,
      3600,
      { skipPurge: true },
    );
    const keys = await deps.keyService.listForUser(resolved.externalUser.id);

    const revealBlock = flashed
      ? `<div class="card">
          <h2>Copy your new API key</h2>
          <p class="muted">This secret is shown once. Store it now — it cannot be retrieved later.</p>
          <div class="secret">${escapeHtml(flashed.secret)}</div>
          ${flashed.label ? `<p class="muted">Label: ${escapeHtml(flashed.label)}</p>` : ''}
        </div>`
      : '';

    const rows = keys.length === 0
      ? '<tr><td colspan="6" class="muted">No API keys yet.</td></tr>'
      : (await Promise.all(keys.map(async (key) => {
        const revokeCsrf = key.status === 'active'
          ? await deps.ephemeralStore.issueCsrfToken(resolved.externalUser.id, 3600, { skipPurge: true })
          : '';
        return `<tr>
          <td>${escapeHtml(key.label)}</td>
          <td><code>${escapeHtml(key.id)}</code></td>
          <td class="${key.status === 'active' ? 'status-active' : 'status-revoked'}">${escapeHtml(key.status)}</td>
          <td>${formatTs(key.created_at)}</td>
          <td>${formatTs(key.last_used_at)}</td>
          <td>
            ${key.status === 'active'
    ? `<form class="inline" method="post" action="/developer/keys/${escapeHtml(key.id)}/revoke">
                ${csrfField(revokeCsrf)}
                <button class="danger" type="submit">Revoke</button>
              </form>`
    : '—'}
          </td>
        </tr>`;
      }))).join('');

    const body = `${nav(deps.publicBaseUrl)}
      <h1>API Keys</h1>
      ${consoleErrorBanner(errorCode)}
      ${revealBlock}
      <div class="card">
        <p class="muted">Active keys: ${keys.filter((k) => k.status === 'active').length} / ${deps.maxActiveKeys}</p>
        <table>
          <thead><tr><th>Label</th><th>ID</th><th>Status</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Create a key</h2>
        <form method="post" action="/developer/keys">
          ${csrfField(csrfToken)}
          <label for="label">Label</label>
          <input id="label" name="label" type="text" maxlength="120" placeholder="My laptop" required />
          <button type="submit">Create API key</button>
        </form>
      </div>`;
    return htmlPage('API Keys', body);
  }

  const revokeMatch = path.match(/^\/developer\/keys\/([^/]+)\/revoke$/);
  if (revokeMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return redirectToLogin(deps.publicBaseUrl, path);
    await readValidatedForm(req, resolved.externalUser.id, deps);
    const keyId = revokeMatch[1] ?? '';
    await deps.keyService.revokeForUser(resolved.externalUser.id, keyId);
    return Response.redirect(`${deps.publicBaseUrl}/developer/keys`, 302);
  }

  if (path === '/developer/device') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const resolved = await resolveHostedExternalUser(req, deps);
    const url = new URL(req.url);
    const userCode = (url.searchParams.get('code') ?? '').trim().toUpperCase();
    if (!userCode) {
      return htmlPage('Device login', `${nav(deps.publicBaseUrl)}<div class="card"><p>Missing device code.</p></div>`);
    }
    if (!resolved) {
      return redirectToLogin(deps.publicBaseUrl, `/developer/device?code=${encodeURIComponent(userCode)}`);
    }
    const grant = await deps.deviceAuthStore.getGrantByUserCode(userCode);
    if (!grant || grant.status === 'expired') {
      return htmlPage('Device login', `${nav(deps.publicBaseUrl)}<div class="card"><p class="muted">This device login request is missing or expired.</p></div>`);
    }
    const csrfToken = await deps.ephemeralStore.issueCsrfToken(resolved.externalUser.id);
    const body = `${nav(deps.publicBaseUrl)}
      <h1>Approve CLI login</h1>
      <div class="card">
        <p>A CLI tool is requesting access for <strong>${escapeHtml(resolved.externalUser.email)}</strong>.</p>
        <p>User code: <code>${escapeHtml(grant.user_code)}</code></p>
        <p class="muted">Approving will create a personal API key labeled "CLI device login" and deliver it to the waiting CLI session.</p>
        <form method="post" action="/developer/device/approve">
          ${csrfField(csrfToken)}
          <input type="hidden" name="user_code" value="${escapeHtml(grant.user_code)}" />
          <button type="submit">Approve CLI login</button>
        </form>
      </div>`;
    return htmlPage('Approve CLI login', body);
  }

  if (path === '/developer/device/approve') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const resolved = await resolveHostedExternalUser(req, deps);
    if (!resolved) return unauthorizedHtmlRedirect(deps.publicBaseUrl);
    const form = await readValidatedForm(req, resolved.externalUser.id, deps);
    const userCode = String(form.get('user_code') ?? '').trim().toUpperCase();
    const grant = await deps.deviceAuthStore.getGrantByUserCode(userCode);
    if (!grant || grant.status !== 'pending') {
      throw new HttpError(409, 'conflict', 'Device authorization request is not pending.');
    }

    const created = await deps.keyService.createForUser(resolved.externalUser.id, 'CLI device login');
    try {
      await deps.deviceAuthStore.approveGrant(userCode, {
        user_id: resolved.externalUser.id,
        key_id: created.key.id,
        api_key_secret: created.secret,
      });
    } catch (err) {
      await deps.keyService.revokeForUser(resolved.externalUser.id, created.key.id).catch((revokeErr) => {
        console.error(
          '[agentbootup-server] warn: device-auth rollback revoke failed',
          { keyId: created.key.id, userId: resolved.externalUser.id, error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr) },
        );
      });
      throw err;
    }

    const body = `${nav(deps.publicBaseUrl)}
      <h1>CLI login approved</h1>
      <div class="card"><p>The waiting CLI session can now retrieve its API key. You may close this tab.</p></div>`;
    return htmlPage('CLI login approved', body);
  }

  return null;
}

function unauthorizedHtmlRedirect(publicBaseUrl: string): Response {
  return redirectToLogin(publicBaseUrl, '/developer');
}
