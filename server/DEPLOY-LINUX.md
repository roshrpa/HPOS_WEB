# Put the Hollywood server on a Linux server (step by step)

You will do this once, about 30 minutes. Copy each block, paste it into the server window (SSH) and press Enter. Nothing here touches your tablets until the very end.

What you get: one address, for example `https://pos.yourshop.com`, that serves the order pad (`/`), the POS (`/pos/`) and the database behind them. 1 to 3 tablets or phones and the counter POS all save to it.

## 0. What you need first

- A Linux server: Ubuntu 24.04, 2 GB RAM or more, 20 GB disk or more, with a public IP address. (Hetzner, DigitalOcean, Contabo and similar all work.)
- A domain name pointing to it: at your domain provider add an **A record**, name `pos`, value = the server's IP. Wait a few minutes. (No domain? Use a free name from https://www.duckdns.org and point it to the IP.)
- A way to log in: on Windows open PowerShell and type `ssh root@YOUR_SERVER_IP`. Use an SSH key if the provider offers it. Do not share the password or key with anyone, including Claude.

## 1. Update the server and switch on the firewall

```sh
apt update && apt -y upgrade
apt -y install ufw git curl
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable
```

Only login (22) and web (80, 443) are open. The database is never open to the internet.

## 2. Install Docker

```sh
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

Both commands at the end must print a version number.

## 3. Get the server code

```sh
git clone https://github.com/roshrpa/HPOS_WEB.git /opt/hpos
cd /opt/hpos/server
cp .env.example .env
```

## 4. Fill in the settings

Make three secrets and keep them safe (a password manager is best):

```sh
echo "Database password: $(openssl rand -hex 16)"
echo "Admin token:      $(openssl rand -hex 16)"
```

Now edit the settings file:

```sh
nano .env
```

Set these lines (replace the example values; leave the others):

```
POSTGRES_PASSWORD=<the database password above>
ADMIN_TOKEN=<the admin token above>
DOMAIN=pos.yourshop.com
```

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

## 5. Download the order pad and start everything

```sh
./get-tablet-app.sh
docker compose up -d --build
docker compose ps
```

All three services (`db`, `api`, `caddy`) should say `running`. The first start takes a few minutes. Caddy then gets the HTTPS certificate by itself.

Check it:

```sh
curl https://pos.yourshop.com/health
```

It must answer `{"ok":true}`. If it does not, see "If something goes wrong" at the end.

## 6. Create the first user and connect the apps

Nothing to register by hand and no tokens to copy any more. Users live on the server and a device connects when a user signs in.

- Create the first Owner on the server, once. Type your own name and a PIN of 6 digits or more in this command (run it in `/opt/hpos/server`):
  ```sh
  source .env
  curl -s -X POST https://pos.yourshop.com/admin/users -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"name":"YourName","pin":"123456","role":"Owner"}'
  ```
  The same command with an existing name resets that user's PIN (use it if the Owner forgets the PIN).
- Open `https://pos.yourshop.com/pos/` (or the Windows app, or the APK). Every device shows *Sign in*: user name and PIN. The server then gives that device its own token behind the scenes.
- Add staff in the POS **Users** tab (Owner only). New users can sign in on any device straight away. A user who is deactivated is signed out of every device within a minute.
- Tablet order pad: ☰ > Edit menu > *Sync with the server* > user name and PIN of any shop user > *Connect to the server*.
- After 5 wrong PINs for one user the server blocks that user for 15 minutes.

Without internet a device still works: it keeps its own copy of the users and checks the PIN on the device. It signs in against the server again whenever the internet is back.

## 7. Daily backup (do not skip)

```sh
cd /opt/hpos/server
chmod +x scripts/backup.sh
./scripts/backup.sh
(crontab -l 2>/dev/null; echo "30 3 * * * cd /opt/hpos/server && ./scripts/backup.sh") | crontab -
```

This saves one compressed copy of the database every night at 3:30 and keeps 30 days. Also switch on the provider's server **snapshot/backup** option, and now and then copy the `backups` folder to your computer or a cloud folder.

## 9. Updating later

When the apps change (new features):

```sh
cd /opt/hpos && git pull
cd server && ./get-tablet-app.sh
docker compose up -d --build
```

Your data stays. Tablets get the new page the next time they reload.

## 10. If something goes wrong

| Problem | What to check |
| --- | --- |
| `curl .../health` does not answer | `docker compose logs caddy` (certificate) and `docker compose logs api`. The domain's A record must point to this server's IP, and ports 80 and 443 must be open at the provider's firewall too. |
| `docker compose up` says set POSTGRES_PASSWORD / ADMIN_TOKEN / DOMAIN | The `.env` file is missing one of the three lines. |
| Device says wrong token | Register the device again and use the new token. |
| A tablet was lost | Stop it syncing: `docker compose exec db psql -U hpos hpos -c "update devices set active=false where name='Tablet 1'"` |
| Want to see the data | `docker compose exec db psql -U hpos hpos` |

Never put `.env` in git and never send the admin token in chat or email.
