Local LLM Gateway - Windows Portable Edition
=============================================

Quick start
-----------
1. Extract the ZIP to a normal writable folder.
2. Double-click "Start Gateway.cmd" or "启动网关.cmd".
3. Your browser opens http://127.0.0.1:8317/admin automatically.
4. Add a Provider, API Key, and Model in the dashboard.

No installation, administrator permission, or separate Node.js installation is required.
The gateway listens on this computer only by default.

Files created after first launch
--------------------------------
- .env                  local settings
- data/gateway.db       configuration and usage database
- data/master.key       encryption key for stored provider API keys
- logs/                 local process logs
- run/gateway.pid       process tracking file

IMPORTANT: Back up data/gateway.db and data/master.key together. If master.key
is lost, encrypted provider API keys in the database cannot be recovered.

Stopping and updating
---------------------
- Double-click "Stop Gateway.cmd" or "停止网关.cmd" to stop the gateway.
- Before updating, stop it and back up the entire data folder.
- Extract a newer portable version to a new folder, then copy only .env and the
  data folder from the old version. Never publish those files.

Security
--------
- Keep LOCAL_GATEWAY_HOST=127.0.0.1 unless you understand network exposure.
- Do not send .env, data/gateway.db, or data/master.key to anyone.
- Download releases only from:
  https://github.com/wangtx-wtx/local-llm-gateway/releases
