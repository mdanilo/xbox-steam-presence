#!/usr/bin/env bash
# Instala ou atualiza o serviço. Rode com: sudo ./install.sh
#  - código em /opt/xbox-steam-presence (dono root, somente leitura)
#  - roda como o usuário de sistema "xboxsteam" (sem shell, sem acesso à sua home)
#  - chave e token em /var/lib/xbox-steam-presence (700/600)
#  - painel em http://127.0.0.1:8787, iniciado com o PC (sem consumo enquanto Desligado)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode com sudo: sudo ./install.sh"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
REAL_USER="${SUDO_USER:?Rode via sudo a partir do seu usuário}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
USER_CONF="$REAL_HOME/.config/xbox-steam-presence"
APP=/opt/xbox-steam-presence
STATE=/var/lib/xbox-steam-presence
SVC=xboxsteam
UNIT=xbox-steam-presence.service

has_key() { [ -f "$1" ] && grep -qE '^[[:space:]]*OPENXBL_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$1"; }

# Node do sistema (o do nvm fica na sua home, que o serviço não enxerga).
NODE_BIN="$(readlink -f "$(sudo -u "$REAL_USER" bash -lc 'command -v node' 2>/dev/null || echo /usr/bin/node)")"
case "$NODE_BIN" in /home/*|/root/*) echo "O Node está em $NODE_BIN. Instale o Node no sistema (apt/NodeSource)."; exit 1 ;; esac
[ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Precisa do Node 20+ no sistema."; exit 1; }
[ -f "$SRC/dist/src/index.js" ] && [ -d "$SRC/node_modules" ] || { echo "Rode antes, sem sudo: ./setup.sh"; exit 1; }

# --- Segredos: da sua home para o serviço (movidos, não copiados) ---
for f in config.env steam-refresh-token; do
  [ ! -L "$USER_CONF/$f" ] || { echo "Recusado: $USER_CONF/$f é um link simbólico."; exit 1; }
done
# Um config.env sem chave (ex.: modelo) nunca substitui uma configuração instalada.
if [ -f "$USER_CONF/config.env" ] && ! has_key "$USER_CONF/config.env" && [ -s "$STATE/config.env" ]; then
  rm -f "$USER_CONF/config.env"
fi
has_key "$USER_CONF/config.env" || has_key "$STATE/config.env" || { echo "Coloque a OPENXBL_KEY em $USER_CONF/config.env (veja o README)."; exit 1; }
[ -s "$USER_CONF/steam-refresh-token" ] || [ -s "$STATE/steam-refresh-token" ] || { echo "Faça o login da Steam antes: npm run login"; exit 1; }

getent passwd "$SVC" >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC"
install -d -m 700 -o "$SVC" -g "$SVC" "$STATE"
for f in config.env steam-refresh-token; do
  if [ -s "$USER_CONF/$f" ]; then
    install -m 600 -o "$SVC" -g "$SVC" "$USER_CONF/$f" "$STATE/$f"
    shred -u "$USER_CONF/$f" 2>/dev/null || rm -f "$USER_CONF/$f"
    echo "Movido: $f -> $STATE/"
  fi
done
rm -rf "$USER_CONF/steam-data" "$USER_CONF"/*.save
rmdir "$USER_CONF" 2>/dev/null || true

# --- Código ---
systemctl stop "$UNIT" 2>/dev/null || true
rm -rf "$APP"
install -d -m 755 "$APP"
cp -r "$SRC/dist" "$SRC/node_modules" "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
rm -rf "$APP/dist/test"
(cd "$APP" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
chown -R root:root "$APP" && chmod -R u=rwX,go=rX "$APP"

# Restos de versões anteriores.
rm -f /etc/polkit-1/rules.d/50-xbox-steam-presence.rules /usr/local/bin/xbox-steam

# --- Serviço e atalho ---
sed "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" "$SRC/$UNIT" > "/etc/systemd/system/$UNIT"
chmod 644 "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null
sudo -u "$REAL_USER" install -D -m 644 "$SRC/xbox-steam.desktop" "$REAL_HOME/.local/share/applications/xbox-steam.desktop"

sleep 2
if systemctl is-active --quiet "$UNIT"; then
  echo
  echo "Pronto! Abra o painel: http://127.0.0.1:8787  (ou \"Xbox → Steam\" no menu de aplicativos)"
else
  echo "O serviço não subiu. Veja: journalctl -u $UNIT -n 20"; exit 1
fi
