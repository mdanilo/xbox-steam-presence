// Login inicial (interativo, roda UMA vez).
// Pede usuário, senha e código do Steam Guard e salva apenas o refresh token.
// A senha nunca é gravada em disco nem exibida no terminal.

import fs from 'node:fs';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import SteamUser from 'steam-user';
import { CONFIG_DIR, STEAM_DATA_DIR, TOKEN_FILE, writeSecret } from './config.js';

/** Pergunta no terminal; com hidden=true nada do que é digitado aparece. */
function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden; // a pergunta já foi escrita; a partir daqui, silêncio
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Rode este comando num terminal interativo.');
    process.exit(1);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const accountName = await ask('Usuário da Steam (login, não o apelido): ');
  let password = await ask('Senha da Steam: ', true);

  const client = new SteamUser({ dataDirectory: STEAM_DATA_DIR, autoRelogin: false });
  let saved = false;

  client.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
    if (lastCodeWrong) console.log('Código incorreto, tente de novo.');
    const where = domain ? `enviado para o e-mail em ${domain}` : 'do app Steam Mobile';
    void ask(`Código do Steam Guard (${where}): `).then(callback);
  });

  client.on('refreshToken', (token: string) => {
    writeSecret(TOKEN_FILE, token);
    saved = true;
    console.log(`\nPronto! Refresh token salvo em ${TOKEN_FILE} (permissão 600).`);
    console.log('Ele dá acesso à sua conta: não compartilhe esse arquivo.');
  });

  client.on('loggedOn', () => {
    password = ''; // não precisamos mais dela
    // Dá tempo para o evento refreshToken chegar e então desconecta.
    setTimeout(() => {
      client.logOff();
      if (!saved) console.error('Login feito, mas a Steam não enviou o token. Tente de novo.');
      process.exit(saved ? 0 : 1);
    }, 5000);
  });

  client.on('error', (err: Error & { eresult?: number }) => {
    console.error(`Falha no login: ${err.message} (EResult ${err.eresult ?? '?'})`);
    process.exit(1);
  });

  client.logOn({ accountName, password, machineName: 'xbox-steam-presence' });
}

void main();
