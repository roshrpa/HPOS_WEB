# Hollywood Ice Creams — POS (web) and server

| Part | Where |
|---|---|
| **POS** (counter billing, stock, day close) | `index.html` — live at https://roshrpa.github.io/HPOS_WEB/ |
| **Server** (PostgreSQL + API, sync) | `server/` — see `server/README.md` |
| Tablet order pad (Android app) | separate repository: https://github.com/roshrpa/HPOS_MOBILE (live at https://roshrpa.github.io/HPOS_MOBILE/) |

The POS is a single HTML file. It works on its own and keeps its data in the browser; connect it to the server in **Settings → Sync with the server** to share data between computers.
