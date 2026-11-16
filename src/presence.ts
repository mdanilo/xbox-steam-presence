// Status do Xbox pela OpenXBL (https://xbl.io) e detecção do jogo em primeiro plano.

import type { Config } from './config.js';

interface XboxPerson {
  state?: string; // "Online", "Offline"
  devices?: { type?: string; titles?: { name?: string; placement?: string; state?: string }[] }[];
}

export class PresenceError extends Error {
  constructor(message: string, readonly fatal = false, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

/** Telas do sistema que não são jogos. */
const NOT_GAMES = new Set(['home', 'início', 'online', 'xbox', 'xbox app', 'microsoft store', 'settings', 'configurações', 'guide']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A OpenXBL já respondeu com array, { people: [...] } e { content: {...} }. */
export function extractPerson(data: unknown): XboxPerson | null {
  if (Array.isArray(data)) return (data.find((p) => isObject(p) && Array.isArray(p.devices)) ?? data[0] ?? null) as XboxPerson | null;
  if (!isObject(data)) return null;
  if (Array.isArray(data.people)) return extractPerson(data.people);
  if (isObject(data.content)) return extractPerson(data.content);
  return data as XboxPerson;
}

export const isOnline = (data: unknown): boolean => String(extractPerson(data)?.state ?? '').toLowerCase() === 'online';

/** Remove caracteres de controle e de direção de texto; limita o tamanho. */
export const sanitizeName = (name: string): string =>
  name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100);

/**
 * Nome do jogo em primeiro plano num dispositivo permitido, ou null.
 * Jogos em primeiro plano podem vir "Inactive" (Xbox Cloud Gaming, jogador parado
 * no menu); o critério é não estar em segundo plano. Vence tela cheia + ativo.
 */
export function detectGame(data: unknown, opts: Pick<Config, 'deviceTypes' | 'ignoreTitles'>): string | null {
  const person = extractPerson(data);
  if (!person || String(person.state ?? '').toLowerCase() !== 'online') return null;

  let best: { name: string; score: number } | null = null;
  for (const device of Array.isArray(person.devices) ? person.devices : []) {
    if (!isObject(device)) continue;
    if (opts.deviceTypes.length && !opts.deviceTypes.includes(String(device.type ?? '').toLowerCase())) continue;
    for (const t of Array.isArray(device.titles) ? device.titles : []) {
      if (!isObject(t)) continue;
      const name = sanitizeName(String(t.name ?? ''));
      const placement = String(t.placement ?? '').toLowerCase();
      const lower = name.toLowerCase();
      if (!name || NOT_GAMES.has(lower) || opts.ignoreTitles.includes(lower) || placement === 'background') continue;
      const score = (placement === 'full' ? 2 : 0) + (String(t.state ?? 'active').toLowerCase() === 'active' ? 1 : 0);
      if (!best || score > best.score) best = { name, score };
    }
  }
  return best?.name ?? null;
}

export async function fetchPresence(key: string, url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'X-Authorization': key, Accept: 'application/json', 'Accept-Language': 'pt-BR' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error', // nunca reenvia a chave para outro endereço
  });
  if (res.status === 401 || res.status === 403) throw new PresenceError('A OpenXBL recusou a chave (OPENXBL_KEY).', true);
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    throw new PresenceError('OpenXBL: limite de requisições atingido.', false, retry > 0 ? Math.min(retry, 3600) : 900);
  }
  if (!res.ok) throw new PresenceError(`OpenXBL respondeu HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > 1_000_000) throw new PresenceError('Resposta da OpenXBL grande demais.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PresenceError('Resposta da OpenXBL não é JSON válido.');
  }
}
