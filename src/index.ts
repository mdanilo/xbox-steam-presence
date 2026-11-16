// Serviço: painel em http://127.0.0.1:8787 + espelhamento Xbox -> Steam.
//
//   node dist/src/index.js          -> roda o serviço
//   node dist/src/index.js --check  -> só consulta o Xbox e mostra o que detectou (não toca na Steam)

import {
  EX_CONFIG, PANEL_PORT, PRESENCE_URL, STATE_FILE, STEAM_DATA_DIR, TOKEN_FILE,
  loadConfig, readSecret, writeSecret, type Config,
} from './config.js';
import { Mirror, type Mode } from './mirror.js';
import { startPanel } from './panel.js';
import { detectGame, fetchPresence } from './presence.js';
import { createSteamClient } from './steam.js';

const log = (msg: string): void => console.log(msg);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** Só "Sempre ligado" sobrevive a um reinício. */
function savedMode(): Mode {
  try {
    return (JSON.parse(readSecret(STATE_FILE) ?? '{}') as { mode?: unknown }).mode === 'always' ? 'always' : 'off';
  } catch {
    return 'off';
  }
}

async function main(): Promise<void> {
  let cfg: Config;
  try { cfg = loadConfig(); } catch (e) { fail(errMsg(e), EX_CONFIG); }

  if (process.argv.includes('--check')) {
    if (!cfg.openxblKey) fail('Falta a OPENXBL_KEY no config.env.', EX_CONFIG);
    const data = await fetchPresence(cfg.openxblKey, PRESENCE_URL);
    console.log(JSON.stringify(data, null, 2));
    console.log('\nJogo detectado:', detectGame(data, cfg) ?? '(nenhum)');
    return;
  }

  const mirror = new Mirror({
    cfg,
    createSteam: () => createSteamClient(STEAM_DATA_DIR),
    fetchPresence: () => fetchPresence(cfg.openxblKey, PRESENCE_URL),
    readToken: () => readSecret(TOKEN_FILE),
    saveToken: (t) => writeSecret(TOKEN_FILE, t),
    saveMode: (mode) => {
      try { writeSecret(STATE_FILE, JSON.stringify({ mode })); } catch (e) { log(`Aviso: modo não salvo (${errMsg(e)}).`); }
    },
    log,
  }, savedMode());

  await startPanel({ port: PANEL_PORT, getStatus: () => mirror.status(), setMode: (m) => mirror.setMode(m), refresh: () => mirror.refreshNow() })
    .catch((e: unknown) => fail(`Não consegui abrir o painel na porta ${PANEL_PORT}: ${errMsg(e)}`, EX_CONFIG));
  log(`Painel em http://127.0.0.1:${PANEL_PORT} (modo: ${mirror.status().mode})`);

  const stop = (): void => {
    mirror.shutdown(); // limpa o status na Steam e desconecta
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Rede de segurança: falha inesperada encerra com 1 e o systemd reinicia.
process.on('unhandledRejection', (e) => fail(`Erro inesperado: ${errMsg(e)}`));
process.on('uncaughtException', (e) => fail(`Erro inesperado: ${errMsg(e)}`));
main().catch((e: unknown) => fail(errMsg(e)));

