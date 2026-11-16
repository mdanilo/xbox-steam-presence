import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildConfig } from '../src/config.js';
import { PresenceError, detectGame, extractPerson, fetchPresence, sanitizeName } from '../src/presence.js';

const opts = buildConfig({});

// Resposta real da OpenXBL durante uma partida no Xbox Cloud Gaming (XUID fictício).
const cloudResponse = {
  content: {
    xuid: '1234567890123456',
    state: 'Online',
    devices: [
      {
        type: 'Scarlett',
        titles: [
          { id: '552499398', activity: { richPresence: 'No menu principal' }, name: 'Gears of War 4',
            placement: 'Full', state: 'Inactive', lastModified: '2026-11-16T16:12:37.1526409' },
          { id: '750323071', name: 'Início', placement: 'Background', state: 'Active',
            lastModified: '2026-11-16T16:12:08.011413' },
        ],
      },
      { type: 'Web', titles: [{ id: '1626579248', name: '', placement: 'Full', state: 'Active' }] },
    ],
  },
  code: 200,
};

const person = (titles: object[], type = 'Scarlett', state = 'Online') => [{ state, devices: [{ type, titles }] }];

describe('detectGame', () => {
  it('detecta jogo do Xbox Cloud Gaming (Full + Inactive)', () => {
    assert.equal(detectGame(cloudResponse, opts), 'Gears of War 4');
  });

  it('ignora o Início e jogos em segundo plano', () => {
    assert.equal(detectGame(person([
      { name: 'Início', placement: 'Full', state: 'Active' },
      { name: 'Halo Infinite', placement: 'Background', state: 'Active' },
    ]), opts), null);
  });

  it('prefere o título em tela cheia e ativo', () => {
    assert.equal(detectGame(person([
      { name: 'A', placement: 'Snapped', state: 'Active' },
      { name: 'B', placement: 'Full', state: 'Inactive' },
      { name: 'C', placement: 'Full', state: 'Active' },
    ]), opts), 'C');
  });

  it('ignora dispositivos fora da lista', () => {
    assert.equal(detectGame(person([{ name: 'Halo', placement: 'Full', state: 'Active' }], 'Android'), opts), null);
  });

  it('IGNORE_TITLES soma títulos extras aos embutidos', () => {
    const c = buildConfig({ IGNORE_TITLES: 'Página inicial, Netflix' });
    assert.equal(detectGame(person([{ name: 'Netflix', placement: 'Full' }]), c), null);
    assert.equal(detectGame(person([{ name: 'Início', placement: 'Full' }]), c), null);
    assert.equal(detectGame(person([{ name: 'Halo', placement: 'Full' }]), c), 'Halo');
  });

  it('aceita qualquer dispositivo com DEVICE_TYPES vazio', () => {
    const all = buildConfig({ DEVICE_TYPES: '' });
    assert.equal(detectGame(person([{ name: 'Halo', placement: 'Full' }], 'Android'), all), 'Halo');
  });

  it('retorna null quando offline ou com dados inválidos', () => {
    assert.equal(detectGame({ content: { state: 'Offline' } }, opts), null);
    for (const bad of [null, undefined, 42, 'x', [], {}, { content: null }, [{ state: 'Online', devices: 'x' }],
      [{ state: 'Online', devices: [null, { titles: [null, 1] }] }]]) {
      assert.equal(detectGame(bad, opts), null);
    }
  });

  it('remove caracteres de controle do nome', () => {
    assert.equal(detectGame(person([{ name: 'Forza\u0000\u202e Horizon 5\n', placement: 'Full' }]), opts),
      'Forza Horizon 5');
  });
});

describe('extractPerson', () => {
  it('aceita array, { people } e { content }', () => {
    const p = { state: 'Online', devices: [] };
    assert.equal(extractPerson([p]), p);
    assert.equal(extractPerson({ people: [p] }), p);
    assert.equal(extractPerson({ content: p }), p);
  });
});

describe('sanitizeName', () => {
  it('limita a 100 caracteres', () => {
    assert.equal(sanitizeName('x'.repeat(500)).length, 100);
  });
});

describe('fetchPresence', () => {
  let server: http.Server;
  let base = '';
  const seen: Record<string, string | undefined> = {};

  before(async () => {
    server = http.createServer((req, res) => {
      seen.key = req.headers['x-authorization'] as string | undefined;
      switch (req.url) {
        case '/ok': res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(cloudResponse)); break;
        case '/401': res.statusCode = 401; res.end(); break;
        case '/429': res.statusCode = 429; res.setHeader('retry-after', '120'); res.end(); break;
        case '/500': res.statusCode = 500; res.end(); break;
        case '/redirect': res.statusCode = 302; res.setHeader('location', 'http://example.com/'); res.end(); break;
        default: res.end('isto não é json');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); });

  const get = (p: string) => fetchPresence('chave-teste', base + p);

  it('envia a chave no cabeçalho e devolve o JSON', async () => {
    assert.deepEqual(await get('/ok'), cloudResponse);
    assert.equal(seen.key, 'chave-teste');
  });

  it('401 é erro fatal', async () => {
    await assert.rejects(get('/401'), (e: unknown) => e instanceof PresenceError && e.fatal);
  });

  it('429 respeita o Retry-After', async () => {
    await assert.rejects(get('/429'), (e: unknown) => e instanceof PresenceError && e.retryAfterSeconds === 120);
  });

  it('500 é erro temporário', async () => {
    await assert.rejects(get('/500'), (e: unknown) => e instanceof PresenceError && !e.fatal);
  });

  it('não segue redirecionamentos (a chave não vaza)', async () => {
    await assert.rejects(get('/redirect'));
  });

  it('rejeita resposta que não é JSON', async () => {
    await assert.rejects(get('/texto'), /JSON/);
  });
});
