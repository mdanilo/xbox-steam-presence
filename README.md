<div align="center">

# Xbox → Steam

![Xbox](https://img.shields.io/badge/Xbox-107C10?style=for-the-badge)
![→](https://img.shields.io/badge/→-555555?style=for-the-badge)
![Steam](https://img.shields.io/badge/Steam-1B2838?style=for-the-badge)

Show your **Xbox** game (console or Cloud Gaming) as your **Steam** status.

🎮 *Playing a non-Steam game: **Forza Horizon 5 (Xbox)***

</div>

---

## Install

Needs Linux with systemd, Node.js 20+, and a free [OpenXBL](https://xbl.io) API key.

```bash
git clone https://github.com/mdanilo/xbox-steam-presence.git && cd xbox-steam-presence
./setup.sh
nano ~/.config/xbox-steam-presence/config.env   # OPENXBL_KEY=your_key
npm run login                                   # Steam login, once
sudo ./install.sh
```

## Use

Open **http://127.0.0.1:8787** (or **Xbox → Steam** in your app menu):

| | |
|---|---|
| ⚫ **Desligado** | Off: no polling, disconnected from Steam |
| 🟢 **Ligado** | On until you turn it off or reboot |
| 🔵 **Sempre ligado** | Always on, even after a reboot |

## Update · Uninstall

```bash
git pull && ./setup.sh && sudo ./install.sh
sudo ./uninstall.sh
```

## Security

Steam password never stored · isolated system user · secrets `600` · systemd sandbox · panel bound to `127.0.0.1` with Host/Origin checks.

---

<sub>Unofficial project, not affiliated with Microsoft, Xbox or Valve. Uses the unofficial <code>steam-user</code> client — use at your own risk. · <a href="LICENSE">MIT</a></sub>
