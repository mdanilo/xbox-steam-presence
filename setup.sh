#!/usr/bin/env bash
# Preparação (SEM sudo): dependências, build e testes.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -ne 0 ] || { echo "Rode sem sudo."; exit 1; }

npm ci --ignore-scripts --no-fund --no-audit   # nenhuma dependência executa código na instalação
npm test
npm audit --omit=dev || echo "Atenção: o npm audit encontrou problemas; veja acima."

if [ -f /etc/systemd/system/xbox-steam-presence.service ]; then
  echo; echo "Build pronto. Para atualizar o serviço: sudo ./install.sh"
  exit 0
fi

CONF="${XDG_CONFIG_HOME:-$HOME/.config}/xbox-steam-presence"
install -d -m 700 "$CONF"
[ -f "$CONF/config.env" ] || install -m 600 config.env.example "$CONF/config.env"
cat <<MSG

Próximos passos:
  1) nano "$CONF/config.env"   # cole a OPENXBL_KEY
  2) npm run check              # confere a leitura do Xbox
  3) npm run login              # login da Steam (uma vez)
  4) sudo ./install.sh          # instala e abre o painel
MSG
