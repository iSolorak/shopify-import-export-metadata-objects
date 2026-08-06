# Deployment

Deploying this app to a single VPS with Docker behind the host's nginx.

The container runs the React Router server on loopback port 3000. The host's
nginx terminates TLS and proxies to it. SQLite lives on a Docker named volume
mounted at `/data`.

```
internet ──443──> host nginx ──127.0.0.1:3000──> app container ──> /data/prod.sqlite (volume)
```

## What you need

- A VPS with Docker Engine and the Compose plugin, plus nginx and certbot on the host.
- A DNS A/AAAA record pointing your subdomain (e.g. `app.example.com`) at the VPS.
- A Shopify Partner account with this app created.

## 1. Get the code onto the server

```sh
sudo mkdir -p /srv/shopify-app && sudo chown "$USER" /srv/shopify-app
git clone <your-repo-url> /srv/shopify-app
cd /srv/shopify-app
```

The rest of this guide assumes `/srv/shopify-app` is the working directory.

## 2. Configure the environment

```sh
cp .env.example .env
chmod 600 .env
```

Fill in `.env`. Every variable is documented there; the ones that must change:

| Variable | Where it comes from |
| --- | --- |
| `SHOPIFY_API_KEY` | Partner dashboard → your app → Client ID |
| `SHOPIFY_API_SECRET` | Partner dashboard → your app → Client secret |
| `SHOPIFY_APP_URL` | Your public HTTPS origin, no trailing slash |
| `SCOPES` | Must match `access_scopes` in `shopify.app.toml` |

`.env` is gitignored and excluded from the image by `.dockerignore` — the secret
is injected at runtime by Compose and is never baked into a layer.

`DATABASE_URL` in `.env` is only used for host-side commands. `docker-compose.yml`
overrides it to `file:/data/prod.sqlite` inside the container, so the database
always lands on the volume regardless of what `.env` says.

## 3. Point the Shopify app at your domain

In the Partner dashboard (or in `shopify.app.toml`, then `npm run deploy` from
your workstation), set:

- **App URL**: `https://app.example.com`
- **Allowed redirection URL**: `https://app.example.com/api/auth`

These must match `SHOPIFY_APP_URL` exactly, or OAuth fails with a redirect_uri
mismatch.

Note that `shopify.app.toml` has `automatically_update_urls_on_dev = true`, so
running `shopify app dev` on your workstation rewrites these URLs back to the
dev tunnel. After a dev session, re-run `npm run deploy` before expecting the
production install to work.

## 4. Start the app

```sh
docker compose up -d --build
```

The build is two-stage: devDependencies are used to compile, then only the
compiled output and production dependencies ship in the runtime image, which
runs as the unprivileged `node` user.

On start, `npm run docker-start` runs `prisma migrate deploy` before the server
boots, so migrations are applied automatically on every deploy. The first boot
creates `/data/prod.sqlite`.

Check it:

```sh
docker compose ps          # health should become "healthy" within ~40s
docker compose logs -f app
curl -s localhost:3000/healthz    # {"status":"ok"}
```

`/healthz` runs a real query against the database, so a broken volume mount
shows up as a 503 rather than a healthy container serving errors.

## 5. Set up nginx and TLS

```sh
sudo cp deploy/nginx/shopify-app.conf /etc/nginx/sites-available/shopify-app.conf
sudo ln -s /etc/nginx/sites-available/shopify-app.conf /etc/nginx/sites-enabled/
```

Edit the copy in `/etc/nginx/`: replace `app.example.com` with your domain, and
change the `upstream` port if you set a non-default `APP_PORT`.

The shipped config is HTTP only and names no certificate files, so it validates
before any certificate exists. Apply it, then let certbot add TLS — it copies
the server block to port 443, fills in the certificate paths, and turns port 80
into a redirect.

```sh
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Optionally add HSTS to the port 443 block certbot generated:
`add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`

Then confirm from outside: `curl -sI https://app.example.com/healthz`.

Two details in that config are load-bearing:

- `X-Forwarded-Proto https` — without it the app builds `http://` OAuth
  redirect URLs and Shopify rejects the callback.
- **No** `X-Frame-Options` or `frame-ancestors` CSP. The app renders in an
  iframe inside the Shopify admin and the Shopify library already sends the
  correct per-shop header. If your global `nginx.conf` sets `X-Frame-Options`,
  uncomment the `proxy_hide_header` line, or the embedded app renders blank.

Only ports 80 and 443 need to be open. The container publishes to `127.0.0.1`
only, so port 3000 is not reachable from the internet.

## 6. Install on a store

Open `https://app.example.com/auth/login` (or install from the Partner
dashboard) and enter the shop domain. OAuth writes a row to the `Session`
table; from then on the app is reachable inside the shop's admin.

## Updating

```sh
cd /srv/shopify-app
./deploy/backup.sh            # snapshot first — see below
git pull
docker compose up -d --build
```

Migrations run on boot. There is a few seconds of downtime while the container
restarts. If a config change in `shopify.app.toml` is part of the update, run
`npm run deploy` from your workstation as well — the server never talks to the
Partner API.

Roll back with `git checkout <previous-sha> && docker compose up -d --build`.
Note that Prisma migrations do not roll back automatically; if the bad deploy
included a destructive migration, restore from a backup instead.

## Backups

`deploy/backup.sh` writes a gzipped snapshot to `./backups` and keeps the most
recent 14 (`KEEP=30 ./deploy/backup.sh` to change that).

It uses sqlite3's `.backup`, which is consistent while the app is still
writing. Do not substitute `cp` on the live database file — it can capture a
half-written page and produce a corrupt restore.

Schedule it from the host crontab:

```
15 3 * * * cd /srv/shopify-app && ./deploy/backup.sh >> /var/log/shopify-app-backup.log 2>&1
```

Copy the snapshots off the VPS — a backup that only exists on the machine it
protects is not a backup.

To restore:

```sh
gunzip -c backups/prod-<stamp>.sqlite.gz > /tmp/restore.sqlite
docker compose stop app
docker compose run --rm -T -v /tmp/restore.sqlite:/restore.sqlite app \
  sh -c 'cp /restore.sqlite /data/prod.sqlite'
docker compose up -d app
```

## Operations

```sh
docker compose logs -f app                      # follow logs
docker compose restart app                      # restart
docker compose exec app sqlite3 /data/prod.sqlite '.tables'   # inspect the db
docker compose exec app sh                      # shell in the container
```

Compose does not rotate logs by default. On a long-lived VPS, cap them in
`/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

Then `sudo systemctl restart docker`.

## Compliance webhooks

`app/routes/webhooks.app.compliance.tsx` handles the three mandatory topics
(`customers/data_request`, `customers/redact`, `shop/redact`), declared in
`shopify.app.toml`. `authenticate.webhook` verifies the HMAC, so unsigned
requests are rejected before reaching a handler.

The app stores no customer-identifiable data, so the two customer topics only
log. `shop/redact` deletes the shop's banner settings and sessions. **If you
start storing customer data, you must update these handlers** — Shopify tests
them during App Store review.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Embedded app renders blank in admin | An `X-Frame-Options` or `frame-ancestors` header is being added by nginx. See step 5. |
| OAuth redirects to `http://` and fails | `X-Forwarded-Proto https` missing from the nginx location block. |
| `redirect_uri is not whitelisted` | `SHOPIFY_APP_URL` and the Partner dashboard URLs disagree — often because `shopify app dev` rewrote them. |
| Container unhealthy, logs show Prisma errors | Volume not mounted or unwritable. `docker compose exec app ls -la /data`. |
| Data disappeared after a rebuild | The `app-data` volume was removed (`docker compose down -v`). Restore from a backup. |
| 502 from nginx | Container down, or `proxy_pass` port does not match `APP_PORT`. |
| 413 on a large import | Raise `client_max_body_size` in the nginx config. |

## Scaling limits

This is a deliberately simple single-node setup. SQLite means one writer and
no horizontal scaling: you cannot run two app containers against the same
database. If you outgrow it, move `datasource db` in `prisma/schema.prisma` to
`postgresql`, point `DATABASE_URL` at a Postgres instance, and the rest of this
setup carries over unchanged.
