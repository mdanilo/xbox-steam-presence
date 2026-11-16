// Núcleo: liga/desliga o espelhamento Xbox -> Steam.
//   off    -> nada roda: sem consultas à OpenXBL e desconectado da Steam
//   on     -> espelhando até desligar ou reiniciar o PC
//   always -> espelhando, e continua após reiniciar
// Steam e OpenXBL entram por injeção de dependência (testável sem rede).

import { refreshTokenProblem, type Config } from './config.js';
import { PresenceError, detectGame, isOnline } from './presence.js';

export type Mode = 'off' | 'on' | 'always';
export const MODES: readonly Mode[] = ['off', 'on', 'always'];

export interface SteamClient {
  onLoggedOn(fn: () => void): void;
  onDisconnected(fn: () => void): void;
  onRefreshToken(fn: (token: string) => void): void;
  /** true = você está jogando algo de verdade na Steam em outro lugar. */
  onPlayingBlocked(fn: (blocked: boolean) => void): void;
  onError(fn: (message: string, tokenInvalid: boolean) => void): void;
  logOn(refreshToken: string): void;
  logOff(): void;
  play(name: string | null): void;
}

export interface MirrorDeps {
  cfg: Config;
  createSteam: () => SteamClient;
  fetchPresence: () => Promise<unknown>;
  readToken: () => string | null;
  saveToken: (token: string) => void;
  saveMode: (mode: Mode) => void;
  log: (msg: string) => void;
  /** Espera antes de reconectar à Steam após um erro (ms). */
  retryMs?: number;
}

export interface Status {
  mode: Mode;
  game: string | null;
  xboxOnline: boolean;
  steamConnected: boolean;
  blockedBySteam: boolean;
  lastCheck: string | null;
  error: string | null;
}

const TOKEN_HELP = 'Rode "npm run login" e depois "sudo ./install.sh".';

export class Mirror {
  private mode: Mode;
  private steam: SteamClient | null = null;
  private steamConnected = false;
  private blocked = false;
  private game: string | null = null;
  private xboxOnline = false;
  private lastCheck: number | null = null;
  // Erros separados por origem: um não apaga o outro.
  private fatalError: string | null = null; // exige ação sua (desliga o espelhamento)
  private steamError: string | null = null;
  private xboxError: string | null = null;
  private backoffUntil = 0; // espera imposta por erro/429 da OpenXBL
  private applied: string | null | undefined;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0; // invalida respostas de sessões antigas
  private polling = false;
  private lastPollStart = 0;

  constructor(private readonly deps: MirrorDeps, initialMode: Mode) {
    this.mode = initialMode;
    if (this.active) this.activate();
  }

  private get active(): boolean { return this.mode !== 'off'; }

  status(): Status {
    return {
      mode: this.mode,
      game: this.active ? this.game : null,
      xboxOnline: this.xboxOnline,
      steamConnected: this.steamConnected,
      blockedBySteam: this.blocked,
      lastCheck: this.lastCheck === null ? null : new Date(this.lastCheck).toISOString(),
      error: this.fatalError ?? this.steamError ?? this.xboxError,
    };
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    const wasActive = this.active;
    this.mode = mode;
    this.deps.saveMode(mode);
    this.deps.log(`Modo: ${mode}`);
    if (!wasActive && this.active) this.activate();
    else if (wasActive && !this.active) { this.deactivate(); this.clearErrors(); }
  }

  /**
   * Consulta o Xbox agora, sem esperar o intervalo. Ignorado se desligado, com consulta
   * em andamento, se a última começou há menos de 10 s ou durante a espera de um erro/429
   * (protege a cota da OpenXBL).
   */
  refreshNow(now = Date.now()): boolean {
    if (!this.active || this.polling || now - this.lastPollStart < 10_000 || now < this.backoffUntil) return false;
    clearTimeout(this.timer);
    void this.poll(this.generation);
    return true;
  }

  shutdown(): void { this.deactivate(); }

  // ---------- ciclo de vida ----------

  private activate(): void {
    this.clearErrors();
    if (!this.deps.cfg.openxblKey) return this.fail('Falta a OPENXBL_KEY no config.env.');
    const token = this.loadToken();
    if (!token) return;

    const gen = ++this.generation;
    this.connectSteam(token, gen);
    void this.poll(gen);
  }

  private deactivate(): void {
    this.generation++;
    clearTimeout(this.timer);
    if (this.steam) {
      try { if (this.steamConnected) this.steam.play(null); this.steam.logOff(); } catch { /* ignora */ }
    }
    this.steam = null;
    this.steamConnected = false;
    this.blocked = false;
    this.game = null;
    this.xboxOnline = false;
    this.applied = undefined;
    this.polling = false;
    this.backoffUntil = 0;
  }

  private clearErrors(): void {
    this.fatalError = this.steamError = this.xboxError = null;
  }

  /** Lê e valida o token da Steam. Em caso de problema, desliga com erro e retorna null. */
  private loadToken(): string | null {
    let token: string | null;
    try {
      token = this.deps.readToken();
    } catch (e) {
      this.fail(`${e instanceof Error ? e.message : String(e)} ${TOKEN_HELP}`);
      return null;
    }
    if (!token) { this.fail(`Falta o login da Steam. ${TOKEN_HELP}`); return null; }
    const problem = refreshTokenProblem(token);
    if (problem) { this.fail(`Steam: ${problem}. ${TOKEN_HELP}`); return null; }
    return token;
  }

  /** Erro que exige ação sua: mostra no painel e desliga. */
  private fail(message: string): void {
    this.deps.log(`Erro: ${message}`);
    if (this.active) {
      this.mode = 'off';
      this.deps.saveMode('off');
      this.deactivate();
    }
    this.fatalError = message;
  }

  // ---------- Steam ----------

  private connectSteam(token: string, gen: number): void {
    const steam = this.deps.createSteam();
    this.steam = steam;
    const current = () => gen === this.generation && this.steam === steam;

    steam.onLoggedOn(() => {
      if (!current()) return;
      this.steamConnected = true;
      this.steamError = null;
      this.applied = undefined; // reaplica após reconectar
      this.deps.log('Conectado à Steam.');
      this.apply();
    });
    steam.onDisconnected(() => { if (current()) this.steamConnected = false; });
    steam.onRefreshToken((t) => { if (current()) this.deps.saveToken(t); });
    steam.onPlayingBlocked((blocked) => {
      if (!current()) return;
      this.blocked = blocked;
      if (blocked) this.applied = null; // a Steam já mostra o jogo de verdade
      this.apply();
    });
    steam.onError((message, tokenInvalid) => {
      if (!current()) return;
      if (tokenInvalid) return this.fail(`Token da Steam inválido ou expirado. ${TOKEN_HELP}`);
      // Erro passageiro (rede, manutenção da Steam): tenta de novo em 1 minuto.
      this.steamError = `Steam: ${message}. Tentando de novo em 1 minuto.`;
      this.deps.log(this.steamError);
      this.steamConnected = false;
      this.steam = null;
      setTimeout(() => {
        if (gen !== this.generation) return;
        const t = this.loadToken(); // se o token tiver estragado nesse meio-tempo, desliga com erro
        if (t) this.connectSteam(t, gen);
      }, this.deps.retryMs ?? 60_000);
    });

    steam.logOn(token);
  }

  private apply(): void {
    if (!this.steam || !this.steamConnected) return;
    const want = this.blocked ? null : this.game;
    if (want === this.applied) return;
    try {
      this.steam.play(want ? `${want}${this.deps.cfg.suffix}` : null);
    } catch (e) {
      // Conexão caindo: a reconexão automática reaplica o status depois.
      this.deps.log(`Steam: não consegui atualizar o status (${e instanceof Error ? e.message : String(e)}).`);
      return;
    }
    this.deps.log(want ? `Steam: jogando "${want}${this.deps.cfg.suffix}"` : 'Steam: status limpo');
    this.applied = want;
  }

  // ---------- Xbox ----------

  private async poll(gen: number): Promise<void> {
    let delay = this.deps.cfg.pollSeconds;
    this.polling = true;
    this.lastPollStart = Date.now();
    let data: unknown;
    let ok = false;
    try {
      data = await this.deps.fetchPresence();
      ok = true;
    } catch (e) {
      if (gen !== this.generation) return;
      if (e instanceof PresenceError && e.fatal) return this.fail(e.message);
      const msg = e instanceof Error ? e.message : String(e);
      this.xboxError = msg.startsWith('OpenXBL') ? msg : `OpenXBL: ${msg}`;
      delay = Math.max(delay * 2, e instanceof PresenceError ? e.retryAfterSeconds ?? 0 : 0);
      this.backoffUntil = Date.now() + delay * 1000;
    } finally {
      if (gen === this.generation) this.polling = false;
    }
    if (gen !== this.generation) return;

    if (ok) {
      const game = detectGame(data, this.deps.cfg);
      if (game !== this.game) this.deps.log(`Xbox: ${game ? `jogando "${game}"` : 'sem jogo'}`);
      this.game = game;
      this.xboxOnline = isOnline(data);
      this.lastCheck = Date.now();
      this.xboxError = null;
      this.backoffUntil = 0;
      this.apply(); // fora do try: erro da Steam não vira "erro da OpenXBL"
    }
    this.timer = setTimeout(() => void this.poll(gen), delay * 1000);
  }
}
