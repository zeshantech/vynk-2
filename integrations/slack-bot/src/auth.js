// Per-user Vynk sign-in (OAuth 2 authorization code + PKCE against OpenProject),
// so everything a person does from Slack is done as them in Vynk.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenProject } from "./openproject.js";

const PENDING_TTL_MS = 15 * 60 * 1000;
const b64url = (buf) => buf.toString("base64url");

export class Sessions {
  constructor({ baseUrl, clientId, clientSecret, redirectUri, dataDir }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.file = path.join(dataDir, "sessions.enc");
    this.key = crypto.createHash("sha256").update(`vynk-slack:${clientSecret}`).digest();
    this.pending = new Map();
    this.sessions = new Map();
    this.refreshing = new Map();
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      this.sessions = new Map(Object.entries(JSON.parse(json)));
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`Could not read saved sessions (${err.message}); everyone will need to reconnect.`);
    }
  }

  async save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(this.sessions)), "utf8"), cipher.final()]);
    const tmp = `${this.file}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Sign-in link for one Slack user (valid 15 minutes). */
  connectUrl(slackUserId) {
    const now = Date.now();
    for (const [state, p] of this.pending) if (p.expires < now) this.pending.delete(state);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    this.pending.set(state, { slackUserId, verifier, expires: now + PENDING_TTL_MS });
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "api_v3",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${this.baseUrl}/oauth/authorize?${params}`;
  }

  async tokenRequest(params) {
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || `token request failed (${res.status})`);
      err.code = data.error;
      throw err;
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
    };
  }

  /** Finishes a sign-in: returns { slackUserId, tokens } or throws. */
  async complete(state, code) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error("This sign-in link has expired. Start again from Slack.");
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    return { slackUserId: pending.slackUserId, tokens };
  }

  async store(slackUserId, session) {
    this.sessions.set(slackUserId, session);
    await this.save();
  }

  async remove(slackUserId) {
    const session = this.sessions.get(slackUserId);
    this.sessions.delete(slackUserId);
    await this.save();
    if (session?.refreshToken) {
      await fetch(`${this.baseUrl}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, token: session.refreshToken }),
      }).catch(() => null);
    }
  }

  get(slackUserId) {
    return this.sessions.get(slackUserId) ?? null;
  }

  async accessToken(slackUserId, { force = false } = {}) {
    const session = this.sessions.get(slackUserId);
    if (!session) return null;
    if (!force && session.expiresAt - 60_000 > Date.now()) return session.accessToken;
    if (!this.refreshing.has(slackUserId)) {
      const job = (async () => {
        try {
          const tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: session.refreshToken });
          await this.store(slackUserId, { ...session, ...tokens, refreshToken: tokens.refreshToken || session.refreshToken });
          return tokens.accessToken;
        } catch (err) {
          if (err.code === "invalid_grant") {
            this.sessions.delete(slackUserId);
            await this.save();
            return null;
          }
          throw err;
        } finally {
          this.refreshing.delete(slackUserId);
        }
      })();
      this.refreshing.set(slackUserId, job);
    }
    return this.refreshing.get(slackUserId);
  }

  /** OpenProject client acting as this Slack user (null when not connected). */
  client(slackUserId) {
    if (!this.sessions.has(slackUserId)) return null;
    return new OpenProject({
      baseUrl: this.baseUrl,
      token: (opts) => this.accessToken(slackUserId, opts),
    });
  }
}

export function resultPage({ ok, title, message }) {
  const accent = ok ? "#6B1E2E" : "#B42318";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Vynk</title><link rel="icon" href="/__vynk/logo-mark.svg">
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--card:#161618;--fg:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.1)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:36px 32px;text-align:center;
box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06)}
.dot{width:52px;height:52px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;background:${accent};color:#fff;font-size:24px}
h1{font-size:20px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}p{margin:0;color:var(--muted)}
</style></head><body><main class="card"><div class="dot">${ok ? "&#10003;" : "!"}</div><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}
