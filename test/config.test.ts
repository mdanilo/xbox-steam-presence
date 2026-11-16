import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// O diretório de config é resolvido na importação: aponta para uma pasta temporária antes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsp-test-'));
process.env.XSP_CONFIG_DIR = path.join(tmp, 'conf');
const cfg = await import('../src/config.js');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('parseEnv', () => {
  it('lê pares, aspas e ignora comentários', () => {
    assert.deepEqual(cfg.parseEnv('# c\nA=1\n B = "x y" \nC=\'z\'\ninvalido\n=sem-nome\nD=a=b\n'),
      { A: '1', B: 'x y', C: 'z', D: 'a=b' });
  });
});

describe('buildConfig', () => {
  it('usa padrões seguros', () => {
    const c = cfg.buildConfig({});
    assert.equal(c.pollSeconds, 90);
    assert.equal(c.suffix, ' (Xbox)');
    assert.ok(c.deviceTypes.includes('scarlett'));
  });

  it('não aceita intervalo abaixo de 30 s', () => {
    assert.equal(cfg.buildConfig({ POLL_SECONDS: '5' }).pollSeconds, 90);
    assert.equal(cfg.buildConfig({ POLL_SECONDS: 'abc' }).pollSeconds, 90);
    assert.equal(cfg.buildConfig({ POLL_SECONDS: '120' }).pollSeconds, 120);
  });


  it('limita o tamanho do sufixo', () => {
    assert.equal(cfg.buildConfig({ GAME_SUFFIX: 'x'.repeat(100) }).suffix.length, 40);
  });
});

describe('refreshTokenProblem', () => {
  const jwt = (payload: object) =>
    `e30.${Buffer.from(JSON.stringify({ iss: 'steam', sub: '7656', aud: ['client', 'web'], ...payload })).toString('base64url')}.sig`;
  it('recusa JWT que não é da Steam ou não serve para o cliente', () => {
    assert.match(cfg.refreshTokenProblem(jwt({ iss: 'outro' }), 1000) ?? '', /não é um refresh token/);
    assert.match(cfg.refreshTokenProblem(jwt({ aud: ['web'] }), 1000) ?? '', /não é um refresh token/);
  });
  it('aceita token válido', () => {
    assert.equal(cfg.refreshTokenProblem(jwt({ exp: 2000 }), 1000), null);
  });
  it('detecta token expirado', () => {
    assert.match(cfg.refreshTokenProblem(jwt({ exp: 500 }), 1000) ?? '', /expirou/);
  });
  it('detecta lixo', () => {
    for (const t of ['x', 'a.b', 'a.!!!.c', 'a..c']) {
      assert.match(cfg.refreshTokenProblem(t) ?? '', /formato/);
    }
  });
});

describe('segredos', () => {
  it('writeSecret cria pasta 700 e arquivo 600', () => {
    const file = path.join(cfg.CONFIG_DIR, 'segredo');
    cfg.writeSecret(file, 'abc\n');
    assert.equal(fs.statSync(cfg.CONFIG_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(cfg.readSecret(file), 'abc');
    cfg.writeSecret(file, 'novo'); // sobrescreve de forma atômica
    assert.equal(cfg.readSecret(file), 'novo');
  });

  it('recusa arquivo legível por outros', () => {
    const file = path.join(cfg.CONFIG_DIR, 'aberto');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.throws(() => cfg.readSecret(file), /permissões abertas/);
  });

  it('writeSecret não escreve através de sobra/link no arquivo temporário', () => {
    const file = path.join(cfg.CONFIG_DIR, 'tok');
    const target = path.join(tmp, 'alvo');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, `${file}.tmp-${process.pid}`);
    cfg.writeSecret(file, 'segredo');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original'); // o alvo do link não foi tocado
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('recusa link simbólico', () => {
    const link = path.join(cfg.CONFIG_DIR, 'link');
    fs.symlinkSync('/etc/hostname', link);
    assert.throws(() => cfg.readSecret(link), /não é um arquivo comum/);
  });

  it('readSecret retorna null se o arquivo não existe', () => {
    assert.equal(cfg.readSecret(path.join(cfg.CONFIG_DIR, 'nada')), null);
  });
});
