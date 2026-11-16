#!/usr/bin/env bash
# Remove tudo: serviço, código, chave, token, usuário de sistema e atalho.
# Rode com: sudo ./uninstall.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode com sudo: sudo ./uninstall.sh"; exit 1; }
read -r -p "Isso apaga o serviço, a chave da OpenXBL e o token da Steam. Continuar? [s/N] " ok
[[ "$ok" =~ ^[sS]$ ]] || exit 0

systemctl disable --now xbox-steam-presence.service 2>/dev/null || true
rm -f /etc/systemd/system/xbox-steam-presence.service /etc/polkit-1/rules.d/50-xbox-steam-presence.rules /usr/local/bin/xbox-steam
systemctl daemon-reload
find /var/lib/xbox-steam-presence -type f -exec shred -u {} + 2>/dev/null || true
rm -rf /var/lib/xbox-steam-presence /opt/xbox-steam-presence
if getent passwd xboxsteam >/dev/null; then userdel xboxsteam; fi
if [ -n "${SUDO_USER:-}" ]; then
  rm -f "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.local/share/applications/xbox-steam.desktop"
fi
echo "Removido. Para invalidar o token na Steam: Steam > Configurações > Segurança > Desautorizar outros dispositivos."
