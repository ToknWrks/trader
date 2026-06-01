#!/usr/bin/env node
/**
 * schwab-auth.mjs — one-shot Schwab OAuth authorization
 *
 * Starts a temporary HTTPS server on port 4101, opens the Schwab
 * authorization URL in your browser, catches the callback, exchanges
 * the code for tokens, saves them, and exits.
 *
 * Run once: node schwab-auth.mjs
 * Register:  https://127.0.0.1:4101/schwab/callback  as your Redirect URI
 *            in developer.schwab.com
 */

import { createServer } from "https";
import { execSync, exec } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(resolve(__dirname, ".env"), "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

const CLIENT_ID     = process.env.SCHWAB_API_KEY?.trim();
const CLIENT_SECRET = process.env.SCHWAB_APP_SECRET?.trim();
const PORT          = 4101;
const REDIRECT_URI  = `https://127.0.0.1:${PORT}/schwab/callback`;
const TOKENS_PATH   = resolve(__dirname, "data/schwab-tokens.json");
const CERT_PATH     = resolve(__dirname, "data/schwab-cert.pem");
const KEY_PATH      = resolve(__dirname, "data/schwab-key.pem");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n[schwab-auth] SCHWAB_API_KEY and SCHWAB_APP_SECRET must be set in .env\n");
  process.exit(1);
}

// ── Self-signed cert for 127.0.0.1 ───────────────────────────────────────────

function ensureCert() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) return;
  console.log("[schwab-auth] Generating self-signed cert for 127.0.0.1 …");
  mkdirSync(resolve(__dirname, "data"), { recursive: true });

  // Write SAN config so the cert covers 127.0.0.1 as an IP SAN
  const sanConf = resolve(__dirname, "data/schwab-san.cnf");
  writeFileSync(sanConf, [
    "[req]",
    "distinguished_name = req_distinguished_name",
    "x509_extensions    = v3_req",
    "prompt             = no",
    "[req_distinguished_name]",
    "CN = 127.0.0.1",
    "[v3_req]",
    "subjectAltName = IP:127.0.0.1",
  ].join("\n"));

  execSync(
    `openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes ` +
    `-keyout "${KEY_PATH}" -out "${CERT_PATH}" ` +
    `-config "${sanConf}"`,
    { stdio: "pipe" }
  );
  console.log("[schwab-auth] Cert generated at data/schwab-cert.pem\n");
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const creds = Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
  const res = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const tokens = await res.json();
  mkdirSync(resolve(__dirname, "data"), { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify({ ...tokens, saved_at: Date.now() }, null, 2));
  return tokens;
}

// ── Auth URL ──────────────────────────────────────────────────────────────────

function getAuthUrl() {
  return "https://api.schwabapi.com/v1/oauth/authorize?" + new URLSearchParams({
    response_type: "code",
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
  });
}

// ── One-shot HTTPS server ─────────────────────────────────────────────────────

function successHtml(info) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Schwab Authorized</title>
  <style>body{background:#09090b;color:#fafafa;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{text-align:center;padding:2rem}.check{font-size:3rem;margin-bottom:1rem}.title{font-size:1.25rem;font-weight:700;margin-bottom:0.5rem}
  .sub{color:rgba(255,255,255,0.5);font-size:0.85rem}</style></head>
  <body><div class="box">
    <div class="check">✅</div>
    <div class="title">Schwab Authorized</div>
    <div class="sub">Tokens saved. You can close this tab.</div>
    ${info ? `<div class="sub" style="margin-top:0.5rem">${info}</div>` : ""}
  </div></body></html>`;
}

function errorHtml(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Schwab Auth Error</title>
  <style>body{background:#09090b;color:#f87171;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{text-align:center;padding:2rem}</style></head>
  <body><div class="box"><div style="font-size:3rem;margin-bottom:1rem">❌</div>
  <div style="font-size:1rem">${msg}</div></div></body></html>`;
}

async function run() {
  ensureCert();

  const cert = readFileSync(CERT_PATH);
  const key  = readFileSync(KEY_PATH);

  await new Promise((resolveServer, rejectServer) => {
    const server = createServer({ cert, key }, async (req, res) => {
      const url = new URL(req.url, `https://127.0.0.1:${PORT}`);

      if (url.pathname !== "/schwab/callback") {
        res.writeHead(404); res.end("Not found"); return;
      }

      const code  = url.searchParams.get("code");
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml("Schwab error: " + error));
        server.close(); rejectServer(new Error(error)); return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorHtml("No authorization code in callback URL."));
        server.close(); rejectServer(new Error("No code")); return;
      }

      try {
        const tokens = await exchangeCode(code);
        const refreshDays = Math.round((tokens.refresh_token_expires_in ?? 604800) / 86400);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successHtml(`Refresh token valid for ~${refreshDays} days`));
        console.log("\n[schwab-auth] ✓ Tokens saved to data/schwab-tokens.json");
        console.log("[schwab-auth] Re-run this script before the refresh token expires (~7 days)\n");
        server.close();
        resolveServer();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(errorHtml("Token exchange failed: " + e.message));
        server.close(); rejectServer(e);
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      const authUrl = getAuthUrl();
      console.log(`\n[schwab-auth] HTTPS callback server running on port ${PORT}`);
      console.log(`[schwab-auth] Redirect URI: ${REDIRECT_URI}`);
      console.log(`\n[schwab-auth] Opening Schwab authorization in your browser…`);
      console.log(`[schwab-auth] If it doesn't open automatically, visit:\n  ${authUrl}\n`);

      // Open browser — macOS
      exec(`open "${authUrl}"`, err => {
        if (err) exec(`xdg-open "${authUrl}"`); // Linux fallback
      });
    });

    server.on("error", e => {
      if (e.code === "EADDRINUSE") {
        console.error(`[schwab-auth] Port ${PORT} in use — kill the process using it and retry`);
      }
      rejectServer(e);
    });
  });
}

run().catch(e => {
  console.error("[schwab-auth] Failed:", e.message);
  process.exit(1);
});
