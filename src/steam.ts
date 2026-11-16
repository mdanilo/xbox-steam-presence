// Adaptador da steam-user para a interface usada pelo Mirror.

import SteamUser from 'steam-user';
import type { SteamClient } from './mirror.js';

const R = SteamUser.EResult;
const TOKEN_ERRORS = new Set<number>([R.InvalidPassword, R.AccessDenied, R.Expired, R.Revoked, R.InvalidSignature]);

export function createSteamClient(dataDirectory: string): SteamClient {
  const c = new SteamUser({ dataDirectory, autoRelogin: true, renewRefreshTokens: true });
  return {
    onLoggedOn: (fn) => { c.on('loggedOn', () => fn()); },
    onDisconnected: (fn) => { c.on('disconnected', () => fn()); },
    onRefreshToken: (fn) => { c.on('refreshToken', fn); },
    onPlayingBlocked: (fn) => { c.on('playingState', (blocked: boolean) => fn(blocked)); },
    onError: (fn) => {
      c.on('error', (err: Error & { eresult?: number }) =>
        fn(err.message, err.eresult !== undefined && TOKEN_ERRORS.has(err.eresult)));
    },
    logOn: (refreshToken) => {
      try {
        c.logOn({ refreshToken, machineName: 'xbox-steam-presence' });
      } catch (e) {
        c.emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    },
    logOff: () => { c.logOff(); },
    play: (name) => {
      if (name) {
        c.setPersona(SteamUser.EPersonaState.Online);
        c.gamesPlayed(name);
      } else {
        c.gamesPlayed([]);
      }
    },
  };
}
