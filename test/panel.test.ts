import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Mode, Status } from '../src/mirror.js';
import { startPanel } from '../src/panel.js';

describe('painel', () => {
  let server: http.Server;
  let port = 0;
  let mode: Mode = 'off';
  let refreshes = 0;
  const status = (): Status => ({
    mode, game: 'Jogo <img src=x onerror=alert(1)>', xboxOnline: true, steamConnected: true,
    blockedBySteam: false, lastCheck: null, error: null,
  });

  before(async () => {
    server = await startPanel({ port: 0, getStatus: status, setMode: (m) => { mode = m; }, refresh: () => { refreshes++; return true; } });
    port = (server.address() as AddressInfo).port;
  });
  after(() => { server.close(); });

  /** Requisição crua, para controlar Host e Origin como um atacante faria. */
  const req = (method: string, path: string, headers: Record<string, string> = {}, body = '') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      r.on('error', reject);
      r.end(body);
    });
  const post = (mode: string, headers: Record<string, string> = {}) =>
    req('POST', '/api/mode', { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }, JSON.stringify({ mode }));

  it('escuta só em 127.0.0.1', () => {
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
  });

  it('serve a página com cabeçalhos de segurança', async () => {
    const res = await req('GET', '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('a página não monta HTML com dados (sem innerHTML)', async () => {
    const js = (await req('GET', '/app.js')).body;
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('bloqueia DNS rebinding (Host diferente)', async () => {
    assert.equal((await req('GET', '/api/status', { host: `evil.example:${port}` })).status, 421);
    assert.equal((await req('GET', '/', { host: 'evil.example' })).status, 421);
  });

  it('aceita localhost como Host', async () => {
    assert.equal((await req('GET', '/api/status', { host: `localhost:${port}` })).status, 200);
  });

  it('muda o modo vindo da própria página', async () => {
    for (const m of ['on', 'always', 'off'] as const) {
      const res = await post(m);
      assert.equal(res.status, 200);
      assert.equal(mode, m);
    }
  });

  it('bloqueia CSRF (outra origem ou sem origem)', async () => {
    assert.equal((await post('on', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('on', { origin: 'null' })).status, 403);
    assert.equal((await req('POST', '/api/mode', { 'content-type': 'application/json' }, '{"mode":"on"}')).status, 403);
    assert.equal(mode, 'off');
  });

  it('"Atualizar agora" pede consulta e devolve o status', async () => {
    const res = await req('POST', '/api/refresh', { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, '{}');
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body) as { refreshed: boolean }).refreshed, true);
    assert.equal(refreshes, 1);
  });

  it('"Atualizar agora" também bloqueia CSRF', async () => {
    const res = await req('POST', '/api/refresh', { origin: 'https://evil.example', 'content-type': 'application/json' }, '{}');
    assert.equal(res.status, 403);
    assert.equal((await req('GET', '/api/refresh')).status, 404);
    assert.equal(refreshes, 1);
  });

  it('exige JSON (formulários HTML não passam)', async () => {
    const res = await post('on', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 415);
    assert.equal(mode, 'off');
  });

  it('recusa modo inválido e corpo grande', async () => {
    assert.equal((await post('turbo')).status, 400);
    assert.equal((await post('x'.repeat(100))).status, 413);
    assert.equal(mode, 'off');
  });

  it('GET não muda nada e rotas desconhecidas dão 404', async () => {
    assert.equal((await req('GET', '/api/mode')).status, 404);
    assert.equal((await req('GET', '/../../etc/passwd')).status, 404);
  });
});
