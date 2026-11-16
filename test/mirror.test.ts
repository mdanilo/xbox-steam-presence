import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConfig } from '../src/config.js';
import { Mirror, type Mode, type SteamClient } from '../src/mirror.js';
import { PresenceError } from '../src/presence.js';

const TOKEN = `e30.${Buffer.from(JSON.stringify({ iss: 'steam', sub: '1', aud: ['client'], exp: 9e9 })).toString('base64url')}.sig`;
const playing = (name: string) => ({ state: 'Online', devices: [{ type: 'Scarlett', titles: [{ name, placement: 'Full', state: 'Active' }] }] });
const tick = () => new Promise((r) => setImmediate(r));

class FakeSteam implements SteamClient {
  played: (string | null)[] = [];
  throwOnPlay = false;
  loggedOff = false;
  private h: Record<string, (...a: never[]) => void> = {};
  onLoggedOn(fn: () => void) { this.h.on = fn; }
  onDisconnected(fn: () => void) { this.h.dc = fn; }
  onRefreshToken(fn: (t: string) => void) { this.h.rt = fn; }
  onPlayingBlocked(fn: (b: boolean) => void) { this.h.pb = fn; }
  onError(fn: (m: string, t: boolean) => void) { this.h.err = fn; }
  logOn() { setImmediate(() => this.h.on?.()); }
  logOff() { this.loggedOff = true; }
  play(name: string | null) { if (this.throwOnPlay) throw new Error('socket fechado'); this.played.push(name); }
  emitError(msg: string, tokenInvalid: boolean) { (this.h.err as (m: string, t: boolean) => void)(msg, tokenInvalid); }
  emitBlocked(b: boolean) { (this.h.pb as (b: boolean) => void)(b); }
}

function setup(opts: { key?: string; token?: string | null | (() => string | null); presence?: () => Promise<unknown>; mode?: Mode } = {}) {
  const steams: FakeSteam[] = [];
  const saved: Mode[] = [];
  let fetches = 0;
  const mirror = new Mirror({
    cfg: buildConfig({ OPENXBL_KEY: opts.key ?? 'chave' }),
    createSteam: () => { const s = new FakeSteam(); steams.push(s); return s; },
    fetchPresence: () => { fetches++; return (opts.presence ?? (async () => playing('Halo')))(); },
    readToken: () => (opts.token === undefined ? TOKEN : typeof opts.token === 'function' ? opts.token() : opts.token),
    saveToken: () => {},
    saveMode: (m) => saved.push(m),
    log: () => {},
    retryMs: 5,
  }, opts.mode ?? 'off');
  return { mirror, steams, saved, fetches: () => fetches };
}

describe('Mirror', () => {
  it('desligado não consulta o Xbox nem conecta na Steam', async () => {
    const t = setup();
    await tick();
    assert.equal(t.fetches(), 0);
    assert.equal(t.steams.length, 0);
    t.mirror.shutdown();
  });

  it('ligar consulta, conecta e mostra o jogo com sufixo', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick(); await tick();
    assert.equal(t.fetches(), 1);
    assert.deepEqual(t.steams[0]?.played, ['Halo (Xbox)']);
    assert.equal(t.mirror.status().game, 'Halo');
    assert.equal(t.mirror.status().steamConnected, true);
    assert.deepEqual(t.saved, ['on']);
    t.mirror.shutdown();
  });

  it('desligar limpa o status e desconecta da Steam', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick(); await tick();
    t.mirror.setMode('off');
    assert.deepEqual(t.steams[0]?.played, ['Halo (Xbox)', null]);
    assert.equal(t.steams[0]?.loggedOff, true);
    assert.equal(t.mirror.status().game, null);
  });

  it('"Sempre ligado" inicia ativo', async () => {
    const t = setup({ mode: 'always' });
    await tick(); await tick();
    assert.equal(t.fetches(), 1);
    assert.equal(t.mirror.status().mode, 'always');
    t.mirror.shutdown();
  });

  it('trocar de "on" para "always" não reconecta', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick();
    t.mirror.setMode('always');
    await tick();
    assert.equal(t.steams.length, 1);
    t.mirror.shutdown();
  });

  it('jogo de verdade na Steam tem prioridade', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick(); await tick();
    t.steams[0]?.emitBlocked(true);
    t.steams[0]?.emitBlocked(false);
    assert.deepEqual(t.steams[0]?.played, ['Halo (Xbox)', 'Halo (Xbox)']);
    t.mirror.shutdown();
  });

  it('sem chave, sem token ou token inválido: mostra erro e fica desligado', () => {
    for (const [o, re] of [[{ key: '' }, /OPENXBL_KEY/], [{ token: null }, /login da Steam/], [{ token: 'lixo' }, /formato/]] as const) {
      const t = setup(o);
      t.mirror.setMode('on');
      assert.equal(t.mirror.status().mode, 'off');
      assert.match(t.mirror.status().error ?? '', re);
      assert.equal(t.steams.length, 0);
    }
  });

  it('chave recusada pela OpenXBL desliga com erro', async () => {
    const t = setup({ presence: async () => { throw new PresenceError('A OpenXBL recusou a chave (OPENXBL_KEY).', true); } });
    t.mirror.setMode('on');
    await tick(); await tick();
    assert.equal(t.mirror.status().mode, 'off');
    assert.match(t.mirror.status().error ?? '', /recusou/);
    assert.deepEqual(t.saved, ['on', 'off']);
  });

  it('erro passageiro da OpenXBL mantém ligado e mostra aviso', async () => {
    const t = setup({ presence: async () => { throw new PresenceError('OpenXBL respondeu HTTP 500.'); } });
    t.mirror.setMode('on');
    await tick(); await tick();
    assert.equal(t.mirror.status().mode, 'on');
    assert.match(t.mirror.status().error ?? '', /HTTP 500/);
    t.mirror.shutdown();
  });

  it('token da Steam revogado desliga com erro', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick();
    t.steams[0]?.emitError('InvalidPassword', true);
    assert.equal(t.mirror.status().mode, 'off');
    assert.match(t.mirror.status().error ?? '', /npm run login/);
  });

  it('erro passageiro da Steam reconecta sozinho', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick();
    t.steams[0]?.emitError('ServiceUnavailable', false);
    assert.equal(t.mirror.status().mode, 'on');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.steams.length, 2);
    t.mirror.shutdown();
  });

  it('"Atualizar agora": ignora desligado, consulta em andamento e cliques em menos de 10 s', async () => {
    const t = setup();
    assert.equal(t.mirror.refreshNow(), false); // desligado
    t.mirror.setMode('on');
    assert.equal(t.mirror.refreshNow(), false); // primeira consulta ainda em andamento
    await tick(); await tick();
    assert.equal(t.mirror.refreshNow(Date.now() + 5_000), false); // cedo demais
    assert.equal(t.mirror.refreshNow(Date.now() + 11_000), true);
    await tick(); await tick();
    assert.equal(t.fetches(), 2);
    t.mirror.shutdown();
  });

  // ---- achados do code review ----

  it('token ilegível (permissão/link) não derruba o processo: erro no painel e desligado', () => {
    const t = setup({ token: () => { throw new Error('steam-refresh-token tem permissões abertas demais (644).'); } });
    assert.doesNotThrow(() => t.mirror.setMode('always'));
    assert.equal(t.mirror.status().mode, 'off');
    assert.match(t.mirror.status().error ?? '', /permissões abertas/);
    assert.deepEqual(t.saved, ['always', 'off']); // não volta "sempre ligado" após reiniciar
  });

  it('"Sempre ligado" salvo + token ilegível na inicialização não lança', () => {
    assert.doesNotThrow(() => setup({ mode: 'always', token: () => { throw new Error('ilegível'); } }));
  });

  it('reconexão: token sumiu durante a espera -> desliga com erro (não fica preso)', async () => {
    let token: string | null = TOKEN;
    const t = setup({ token: () => token });
    t.mirror.setMode('on');
    await tick();
    token = null;
    t.steams[0]?.emitError('ServiceUnavailable', false);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.mirror.status().mode, 'off');
    assert.match(t.mirror.status().error ?? '', /login da Steam/);
  });

  it('erro passageiro da Steam some do painel após reconectar', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick();
    t.steams[0]?.emitError('ServiceUnavailable', false);
    assert.match(t.mirror.status().error ?? '', /Steam/);
    await new Promise((r) => setTimeout(r, 20)); // reconecta (retryMs = 5)
    assert.equal(t.mirror.status().steamConnected, true);
    assert.equal(t.mirror.status().error, null);
    t.mirror.shutdown();
  });

  it('consulta OK ao Xbox não esconde erro ainda ativo da Steam', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick(); await tick();
    t.steams[0]?.emitError('ServiceUnavailable', false);
    assert.equal(t.mirror.refreshNow(Date.now() + 11_000), true);
    await tick(); await tick();
    assert.match(t.mirror.status().error ?? '', /^Steam:/);
    t.mirror.shutdown();
  });

  it('"Atualizar agora" respeita a espera após 429 da OpenXBL', async () => {
    const t = setup({ presence: async () => { throw new PresenceError('OpenXBL: limite de requisições atingido.', false, 900); } });
    t.mirror.setMode('on');
    await tick(); await tick();
    assert.equal(t.mirror.refreshNow(Date.now() + 11_000), false);
    assert.equal(t.mirror.refreshNow(Date.now() + 901_000), true);
    t.mirror.shutdown();
  });

  it('falha ao atualizar a Steam não vira "erro da OpenXBL"', async () => {
    const t = setup();
    t.mirror.setMode('on');
    await tick();
    if (t.steams[0]) t.steams[0].throwOnPlay = true;
    await tick();
    assert.equal(t.mirror.status().error, null);
    assert.equal(t.mirror.status().game, 'Halo');
    t.mirror.shutdown();
  });

  it('resposta atrasada de uma sessão antiga é ignorada', async () => {
    let release!: (v: unknown) => void;
    const t = setup({ presence: () => new Promise((r) => { release = r; }) });
    t.mirror.setMode('on');
    t.mirror.setMode('off');
    release(playing('Halo'));
    await tick();
    assert.equal(t.mirror.status().game, null);
    assert.equal(t.steams[0]?.played.includes('Halo (Xbox)'), false);
  });
});
