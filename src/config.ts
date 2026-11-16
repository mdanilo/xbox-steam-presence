// Configuração e segredos. Tudo fica no diretório de configuração (pasta 700, arquivos 600).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR: string = process.env.XSP_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'xbox-steam-presence');
const ENV_FILE = path.join(CONFIG_DIR, 'config.env');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'steam-refresh-token');
export const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
export const STEAM_DATA_DIR = path.join(CONFIG_DIR, 'steam-data');

export const PRESENCE_URL = 'https://xbl.io/api/v2/presence';
export const PANEL_PORT = 8787;

/** Código de saída para erro de configuração. O systemd não reinicia nesse caso. */
export const EX_CONFIG = 78;

export interface Config {
  openxblKey: string;
  pollSeconds: number;
  suffix: string;
  deviceTypes: string[];
  /** Títulos extras a ignorar, além das telas do sistema já embutidas. */
  ignoreTitles: string[];
}

/** Recusa segredos que sejam links, de outro dono ou legíveis por terceiros. */
function assertPrivate(file: string): void {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${file} não é um arquivo comum (link simbólico?).`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${file} não pertence ao usuário atual.`);
  if (st.mode & 0o077) {
    throw new Error(`${file} tem permissões abertas demais (${(st.mode & 0o777).toString(8)}). Rode: chmod 600 "${file}"`);
  }
}

/** Grava com permissão 600 e troca atômica (nunca fica pela metade). */
export function writeSecret(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true }); // remove sobra/link antigo; 'wx' garante arquivo novo com 600
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

export function readSecret(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  assertPrivate(file);
  return fs.readFileSync(file, 'utf8').trim() || null;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const i = line.indexOf('=');
    if (!line || line.startsWith('#') || i < 1) continue;
    let val = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    out[line.slice(0, i).trim()] = val;
  }
  return out;
}

export function buildConfig(env: Record<string, string | undefined>): Config {
  const poll = Number(env.POLL_SECONDS);
  const list = (v: string) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    openxblKey: env.OPENXBL_KEY || '',
    // Plano gratuito da OpenXBL: ~150 req/hora. 90 s = 40 req/hora.
    pollSeconds: Number.isFinite(poll) && poll >= 30 ? poll : 90,
    suffix: (env.GAME_SUFFIX ?? ' (Xbox)').slice(0, 40),
    deviceTypes: list(env.DEVICE_TYPES ?? 'XboxOne,Scarlett,XboxSeries,Xbox360'),
    ignoreTitles: list(env.IGNORE_TITLES ?? ''),
  };
}

export function loadConfig(): Config {
  const file = fs.existsSync(ENV_FILE) ? (assertPrivate(ENV_FILE), parseEnv(fs.readFileSync(ENV_FILE, 'utf8'))) : {};
  return buildConfig({ ...file, ...process.env });
}

/**
 * Confere o refresh token com as mesmas regras da steam-user (emitido pela Steam,
 * válido para o cliente, não expirado). Retorna o problema ou null.
 */
export function refreshTokenProblem(token: string, nowSeconds = Date.now() / 1000): string | null {
  const payload = token.split('.')[1];
  if (token.split('.').length !== 3 || !payload) return 'o token salvo não tem formato válido';
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (p.iss !== 'steam' || typeof p.sub !== 'string' || !Array.isArray(p.aud) || !p.aud.includes('client')) {
      return 'o token salvo não é um refresh token da Steam';
    }
    if (typeof p.exp === 'number' && p.exp <= nowSeconds) return 'o token salvo expirou';
    return null;
  } catch {
    return 'o token salvo não tem formato válido';
  }
}
