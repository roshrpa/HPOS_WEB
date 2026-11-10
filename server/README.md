# Hollywood POS server

PostgreSQL database and a small API that the tablets and counter computers sync with.

What it does today:

- keeps one copy of every bill, cancellation (with reason), discount and day figure
- accepts bills from many devices and ignores repeats, so a retry after a bad connection is safe
- hands each device the events the other devices made
- keeps the menu and settings in one place, with a version number so two people cannot overwrite each other by accident
- gives a day report straight from the database (cash, card, discounts, cancelled bills, sales by category)

The tablet order pad and the POS both sync with it (☰ > Edit menu on the tablet, Settings on the POS: *Sync with the server*). Without a connection they keep working on their own and send everything later.

## Files

| File | Purpose |
| --- | --- |
| `db/schema.sql` | Tables and the SQL functions that do the work. Loaded automatically the first time the database starts. |
| `api/src/server.js` | The HTTP API (Node.js, one dependency: `pg`). |
| `docker-compose.yml` | Starts PostgreSQL, the API and Caddy (HTTPS) together, for a server on the internet. |
| `docker-compose.local.yml` | Same, without HTTPS, for a computer in the shop. Also serves the web apps. |
| `Caddyfile` | Gets and renews the HTTPS certificate. |
| `.env.example` | The settings you fill in. |
| `scripts/backup.sh` | Daily backup. |

## Set it up on a server on the internet

1. Rent a small Linux server (Ubuntu 24.04, 2 CPU, 4 GB RAM, 50 GB disk is plenty). Pick a data centre near you.
2. Point a domain name at it (an `A` record, for example `pos.yourshop.com`).
3. Log in and install Docker: https://docs.docker.com/engine/install/ubuntu/
4. Allow only the ports you need: `ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable`. Use SSH keys, not passwords.
5. Get the code and fill in the settings:

   ```sh
   git clone https://github.com/roshrpa/HPOS.git /opt/hpos
   cd /opt/hpos/server
   cp .env.example .env
   nano .env        # set POSTGRES_PASSWORD, ADMIN_TOKEN, DOMAIN
   docker compose up -d
   ```

6. Check it: `curl https://pos.yourshop.com/health` should answer `{"ok":true}`.
7. Register each device once. The token is shown only this one time, so copy it into the device straight away:

   ```sh
   curl -X POST https://pos.yourshop.com/admin/devices \
     -H "X-Admin-Token: YOUR_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"Tablet 1","kind":"tablet"}'
   ```

8. Back up every day: add `30 3 * * * cd /opt/hpos/server && ./scripts/backup.sh` to `crontab -e`, and copy the `backups` folder somewhere else now and then.

To stop a lost tablet from syncing: `docker compose exec db psql -U hpos hpos -c "update devices set active=false where name='Tablet 1'"`.

## Run it on a computer in the shop first (no server to buy yet)

The same code runs on any Windows, Mac or Linux computer that stays switched on in the shop. The tablets and the counter reach it over the shop Wi-Fi. It also serves the two web apps, so there is no internet address and no HTTPS to set up.

1. Install Docker Desktop (https://www.docker.com/products/docker-desktop/). Turn on "Start Docker Desktop when you sign in".
2. Download this repository (green **Code** button, then **Download ZIP**, or `git clone https://github.com/roshrpa/HPOS_WEB.git`) and open a terminal in its `server` folder.
3. Create the settings file and fill in two lines (`POSTGRES_PASSWORD` and `ADMIN_TOKEN`; leave the rest):

   ```sh
   cp .env.example .env
   ```

4. Download the tablet order pad (it lives in the separate HPOS repository), then start the server:

   ```sh
   powershell -ExecutionPolicy Bypass -File get-tablet-app.ps1      # Mac/Linux: ./get-tablet-app.sh
   docker compose -f docker-compose.local.yml up -d --build
   ```

   Run the first command again whenever the order pad is updated.

5. Find the computer's address on the shop network (for example `192.168.1.20`). In the router, give this computer a fixed address ("DHCP reservation"), otherwise it can change and the tablets will not find it.
6. On a tablet open `http://192.168.1.20:3000/` (order pad) and, on the counter, `http://192.168.1.20:3000/pos/`.
7. Register each device as in step 7 above, but with `http://192.168.1.20:3000` in place of the internet address.

Things to remember:

- The computer must be on and awake whenever the shop is open. Turn off sleep in its power settings.
- Back up every day (`scripts/backup.sh` on Mac/Linux). On Windows run `docker compose -f docker-compose.local.yml exec -T db pg_dump -U hpos hpos > backup.sql` and copy the file to a USB drive or cloud folder.
- Use the address with `http://`, not `https://`. Browsers only let a page call the API with the same kind of address, which is why the API also serves the pages.
- The tablet APK now allows `http` addresses. Because of that change the first time you install the new APK the old app must be removed first, and orders saved inside the old app are lost.

### Moving to a bought server later

1. On the shop computer: `docker compose -f docker-compose.local.yml exec -T db pg_dump -U hpos hpos > hpos.sql`
2. Set the server up with the steps above, then load the file: `docker compose exec -T db psql -U hpos hpos < hpos.sql` (stop the `api` container while you do it).
3. Change the server address on each device. The device tokens move with the database, so devices do not need to be registered again.

## API

All device calls send `Authorization: Bearer <device token>`.

| Call | What it does |
| --- | --- |
| `GET /health` | Answers `{"ok":true}` when the database is reachable. |
| `POST /sync/push` | Body `{"events":[{id, type, t, payload}]}`. Up to 500 events. Returns how many were new and how many repeats. |
| `GET /sync/pull?after=N` | Events made by the other devices after sequence number `N`. Keep the returned `last_seq` for next time. |
| `GET /config/{key}` | Reads the menu or settings, with its version. |
| `PUT /config/{key}` | Body `{"value":{...},"version":N}`. Answers `409` with the current copy if somebody changed it first. |
| `POST /admin/devices` | Registers a device (needs `X-Admin-Token`). |
| `GET /admin/report/day?date=YYYY-MM-DD` | Day report (needs `X-Admin-Token`). |

Event types: `sale` and `sale_cancel` build the sales tables. Other types (`purchase`, `waste`, `stock_count`, `cash_out`, `day_close`) are stored and handed to the other devices as they are.

A `sale` payload:

```json
{ "id": "uuid", "no": "T1-0001", "day": "2026-11-02", "t": 1762050000000, "pay": "cash",
  "subtotal": 50, "discount": 5, "discReason": "Loyal customer", "total": 45,
  "vat": 0, "vatRate": 0, "tendered": 50,
  "lines": [ { "cat": "Milk Shakes", "name": "Chocolate", "size": "", "price": 25, "qty": 2 } ] }
```

A `sale_cancel` payload: `{ "id": "<sale uuid>", "reason": "Wrong item entered", "note": "" }`.

## Good to know

- The database is never opened to the internet. Only the API container can reach it.
- Changing `db/schema.sql` later does not change a database that already exists. Add a new migration file when the time comes.
- This is a first version. It has no user logins yet (only device tokens), so it cannot say which person gave a discount.

## How the apps use it

- **Tablet** saves each order on the tablet and sends it as an `order` event. Edits, deletes and "done" marks go as `order_update`, `order_cancel` and `order_done`.
- **POS** shows those orders under **Tablet orders** on the Sale screen. *Load* puts the order into the bill; when the bill is paid the order is marked done on every tablet.
- Bills, cancellations, purchases, waste, stock counts, cash paid out and day closings are sent from the POS. Bills and cancellations from other POS computers are also fetched and added to the local report. The other event types are stored on the server but are not merged between POS computers yet.
- A device shows a coloured label in the top bar: **Synced**, **n waiting**, **Offline**, or **Not connected**.
