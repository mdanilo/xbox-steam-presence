// Painel web local: http://127.0.0.1:8787
//
// Segurança (sem senha, por ser só local):
//  - escuta apenas em 127.0.0.1;
//  - só aceita o Host "127.0.0.1:PORTA" ou "localhost:PORTA" (bloqueia DNS rebinding);
//  - mudanças só via POST com JSON vindo da própria página (Origin conferido; bloqueia CSRF);
//  - CSP restritiva, nada externo; dados externos (nome do jogo) só via textContent;
//  - corpo limitado a 64 bytes, tempos de requisição curtos.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MODES, type Mode, type Status } from './mirror.js';

interface PanelOptions {
  port: number;
  getStatus: () => Status;
  setMode: (mode: Mode) => void;
  /** Pede uma consulta imediata ao Xbox; false se ignorada (desligado ou cedo demais). */
  refresh: () => boolean;
}

const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

export function startPanel(opts: PanelOptions, host = '127.0.0.1'): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const json = (status: number, data: unknown) => send(status, 'application/json; charset=utf-8', JSON.stringify(data));

    if (!allowedHosts.includes(req.headers.host ?? '')) return json(421, { error: 'host não permitido' });

    const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
    switch (route) {
      case 'GET /': return send(200, 'text/html; charset=utf-8', HTML);
      case 'GET /app.js': return send(200, 'text/javascript; charset=utf-8', JS);
      case 'GET /app.css': return send(200, 'text/css; charset=utf-8', CSS);
      case 'GET /api/status': return json(200, opts.getStatus());
      case 'POST /api/mode': case 'POST /api/refresh': break;
      default: return json(404, { error: 'não encontrado' });
    }

    // POSTs — só da própria página.
    const origin = req.headers.origin ?? '';
    if (!allowedHosts.some((h) => origin === `http://${h}`)) return json(403, { error: 'origem não permitida' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'use JSON' });

    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooBig) return; // descarta sem acumular (requestTimeout limita o tempo)
      body += chunk;
      if (body.length > 64) tooBig = true;
    });
    req.on('end', () => {
      if (tooBig) { res.setHeader('Connection', 'close'); return json(413, { error: 'corpo grande demais' }); }
      if (route === 'POST /api/refresh') return json(200, { refreshed: opts.refresh(), ...opts.getStatus() });
      let mode: unknown;
      try { mode = (JSON.parse(body) as { mode?: unknown }).mode; } catch { /* inválido */ }
      if (!MODES.includes(mode as Mode)) return json(400, { error: 'modo inválido' });
      opts.setMode(mode as Mode);
      json(200, opts.getStatus());
    });
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 30;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => { server.off('error', reject); resolve(server); });
  });
}

// ---------- página ----------

const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Xbox → Steam</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main>
  <h1>Xbox → Steam</h1>
  <div class="modes" role="radiogroup" aria-label="Modo">
    <button type="button" data-mode="off" role="radio">Desligado</button>
    <button type="button" data-mode="on" role="radio">Ligado</button>
    <button type="button" data-mode="always" role="radio">Sempre ligado</button>
  </div>
  <p id="hint" class="hint"></p>
  <dl>
    <dt>Jogo</dt><dd id="game">—</dd>
    <dt>Xbox</dt><dd id="xbox">—</dd>
    <dt>Steam</dt><dd id="steam">—</dd>
    <dt>Última consulta</dt><dd id="check">—</dd>
  </dl>
  <button type="button" id="refresh" class="refresh">Atualizar agora</button>
  <p id="error" class="error" hidden></p>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

const CSS = `:root{--bg:#f3f4f3;--fg:#1b1b1b;--muted:#5f5f5f;--card:#fff;--line:#d6d6d6;--accent:#107c10;--err:#b3261e;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#a3a3a3;--card:#1d1d1d;--line:#333;--accent:#2fa82f;--err:#f28b82}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
main{max-width:460px;margin:0 auto;padding:32px 16px}
h1{font-size:1.3rem;margin:0 0 20px}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px}
.modes button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:14px 4px;background:transparent;color:var(--fg);cursor:pointer}
.modes button[aria-checked=true]{background:var(--accent);color:#fff}
.modes button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hint{color:var(--muted);font-size:.9rem;min-height:1.3em;margin:10px 4px 18px}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.refresh{font:inherit;margin-top:12px;width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);cursor:pointer}
.refresh:disabled{opacity:.5;cursor:default}
.refresh:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.error{color:var(--err);margin:16px 4px}
`;

const JS = `'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const buttons = document.querySelectorAll('[data-mode]');
  const HINTS = {
    off: 'Nada rodando: sem consultas ao Xbox e desconectado da Steam.',
    on: 'Espelhando até você desligar ou reiniciar o PC.',
    always: 'Espelhando sempre, inclusive depois de reiniciar o PC.',
  };

  function render(s) {
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === s.mode)));
    $('hint').textContent = HINTS[s.mode] || '';
    const on = s.mode !== 'off';
    $('game').textContent = !on ? '—' : s.game ? s.game + (s.blockedBySteam ? ' (jogo da Steam tem prioridade)' : '') : 'nenhum';
    $('xbox').textContent = !on ? '—' : s.lastCheck ? (s.xboxOnline ? 'online' : 'offline') : 'consultando…';
    $('steam').textContent = !on ? 'desconectada' : s.steamConnected ? 'conectada' : 'conectando…';
    $('check').textContent = on && s.lastCheck ? new Date(s.lastCheck).toLocaleTimeString('pt-BR') : '—';
    if (!refreshing) $('refresh').disabled = !on;
    $('error').hidden = !s.error;
    $('error').textContent = s.error || '';
  }

  function showError(e) { $('error').hidden = false; $('error').textContent = 'Erro: ' + e.message; }

  let refreshing = false;

  async function refresh() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      render(await r.json());
    } catch (e) { showError(e); }
  }

  async function post(path, data) {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
    return body;
  }

  buttons.forEach((b) => b.addEventListener('click', async () => {
    try { render(await post('/api/mode', { mode: b.dataset.mode })); setTimeout(refresh, 2500); }
    catch (e) { showError(e); }
  }));

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    refreshing = true; btn.disabled = true; btn.textContent = 'Consultando…';
    try {
      const s = await post('/api/refresh');
      render(s);
      if (!s.refreshed) btn.textContent = 'Aguarde um pouco…';
      setTimeout(() => { refreshing = false; btn.textContent = 'Atualizar agora'; refresh(); }, 2500);
    } catch (e) { refreshing = false; btn.textContent = 'Atualizar agora'; showError(e); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  refresh();
})();
`;
