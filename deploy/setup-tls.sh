#!/usr/bin/env bash
#
# Install the nginx site config and obtain the TLS certificate, in that order,
# checking after every step that the thing it just did actually took effect.
#
#   sudo ./deploy/setup-tls.sh
#   sudo DOMAIN=app.example.com EMAIL=me@example.com ./deploy/setup-tls.sh
#   sudo STAGING=1 ./deploy/setup-tls.sh      # rehearse against LE staging
#
# Safe to re-run. It is idempotent: an existing valid certificate is reused
# unless FORCE=1 is set.
#
# The load-bearing step is the pre-flight: it serves a token over plain HTTP
# from the same directory certbot will use and fetches it back over the public
# domain name. Let's Encrypt allows only 5 failed validations per hostname per
# hour, so a failure that can be detected locally must never reach them.

set -euo pipefail

# The values baked into deploy/nginx/shopify-app.conf. That file is installable
# as-is; this script only rewrites these two when DOMAIN/APP_PORT ask for
# something else. Keep them in sync with the conf.
CONF_DOMAIN="shop-app.solorak.xyz"
CONF_PORT="3000"

DOMAIN="${DOMAIN:-$CONF_DOMAIN}"
EMAIL="${EMAIL:-}"
WEBROOT="${WEBROOT:-/var/www/certbot}"
STAGING="${STAGING:-0}"
FORCE="${FORCE:-0}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/deploy/nginx/shopify-app.conf"
TARGET_NAME="shopify-app.conf"

# All progress output goes to stderr so it stays correctly ordered against the
# failure messages, and so stdout stays clean if this is ever piped.
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*" >&2; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*" >&2; }
warn() { printf '    \033[33m!\033[0m   %s\n' "$*" >&2; }
die()  { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

# Never leave nginx holding a config it rejected: put back what was there.
restore_and_die() {  # restore_and_die <backup-path-or-empty> <message>
    local backup="$1"; shift
    if [ -n "$backup" ] && [ -f "$backup" ]; then
        mv "$backup" "$TARGET"
        warn "restored the previous config"
    else
        rm -f "$TARGET" "${NGINX_DIR}/sites-enabled/${TARGET_NAME}"
        warn "removed the config this run had just written"
    fi
    die "$@"
}

[ "$(id -u)" -eq 0 ] || die "run with sudo"
command -v nginx   >/dev/null || die "nginx is not installed"
command -v certbot >/dev/null || die "certbot is not installed (apt install certbot)"
[ -f "$SRC" ] || die "run this from the repo checkout"
grep -q '^# BEGIN TLS$' "$SRC" && grep -q '^# END TLS$' "$SRC" \
    || die "$SRC is missing its BEGIN/END TLS markers — stage 1 cannot strip the 443 block"

# APP_PORT must match the loopback port docker-compose.yml publishes.
APP_PORT="${APP_PORT:-}"
if [ -z "$APP_PORT" ] && [ -f "$REPO_DIR/.env" ]; then
    APP_PORT="$(grep -E '^\s*APP_PORT=' "$REPO_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"'\''[:space:]' || true)"
fi
APP_PORT="${APP_PORT:-$CONF_PORT}"

# ---------------------------------------------------------------------------
# Where does nginx actually read site configs from?
# ---------------------------------------------------------------------------
# A config dropped into a directory nginx does not include is invisible, and the
# symptom is exactly the one this script exists to prevent: requests fall
# through to the default server and the challenge 404s. Resolve the directory
# from the running config rather than assuming conf.d.
say "Locating the nginx config directory"
NGINX_CONF="$(nginx -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p')"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/nginx.conf}"
NGINX_DIR="$(dirname "$NGINX_CONF")"

TARGET=""
if grep -Eq '^\s*include\s+[^;]*conf\.d/\*' "$NGINX_CONF" && [ -d "$NGINX_DIR/conf.d" ]; then
    TARGET="$NGINX_DIR/conf.d/$TARGET_NAME"
    ok "using $NGINX_DIR/conf.d (included by $NGINX_CONF)"
elif grep -Eq '^\s*include\s+[^;]*sites-enabled/\*' "$NGINX_CONF" && [ -d "$NGINX_DIR/sites-available" ]; then
    TARGET="$NGINX_DIR/sites-available/$TARGET_NAME"
    ok "using $NGINX_DIR/sites-available (conf.d is not included)"
else
    die "$NGINX_CONF includes neither conf.d/* nor sites-enabled/*; add an include and re-run"
fi

install_stage() {  # install_stage <with-tls: 0|1> <label>
    local with_tls="$1" label="$2"
    local backup=""
    if [ -f "$TARGET" ]; then
        backup="$TARGET.bak-$(date +%Y%m%d%H%M%S)"
        cp "$TARGET" "$backup"
    fi

    # Stage 1 drops the 443 block: its ssl_certificate does not exist yet, and
    # nginx refuses to load a config that points at a missing certificate.
    local strip=(-e '/^# \(BEGIN\|END\) TLS$/d')
    [ "$with_tls" = "1" ] || strip=(-e '/^# BEGIN TLS$/,/^# END TLS$/d')
    # The conf ships with the real domain and port already in it, so these two
    # substitutions are no-ops on a default run and only bite when DOMAIN or
    # APP_PORT override them. The port pattern is anchored to the loopback
    # address so it cannot match a port number elsewhere in the file.
    sed -e "s/${CONF_DOMAIN//./\\.}/$DOMAIN/g" \
        -e "s/127\.0\.0\.1:$CONF_PORT/127.0.0.1:$APP_PORT/g" \
        "${strip[@]}" "$SRC" > "$TARGET"

    case "$TARGET" in
        */sites-available/*)
            mkdir -p "$NGINX_DIR/sites-enabled"
            ln -sf "$TARGET" "$NGINX_DIR/sites-enabled/$TARGET_NAME"
            ;;
    esac

    # Test once and inspect the output: a rejected config and a duplicate
    # server_name need different messages, and a duplicate is only a warning —
    # nginx keeps whichever block it saw first, which may not be this one.
    local test_out
    test_out="$(nginx -t 2>&1)" || { printf '%s\n' "$test_out"; restore_and_die "$backup" "nginx rejected the $label config"; }
    if printf '%s' "$test_out" | grep -Eiq "conflicting server name.*$DOMAIN"; then
        restore_and_die "$backup" "another server block already claims $DOMAIN — remove it first: nginx -T | grep -n '$DOMAIN'"
    fi
    printf '%s\n' "$test_out"
    systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload \
        || restore_and_die "$backup" "nginx would not reload"
    ok "$label config live at $TARGET"
}

say "Installing the HTTP config (stage 1)"
install_stage 0 "HTTP"

# The config can be syntactically fine and still not be the block that serves
# this hostname. Confirm nginx has really loaded it.
nginx -T 2>/dev/null | grep -q "server_name $DOMAIN;" \
    || die "nginx loaded no server block for $DOMAIN — check 'nginx -T | grep -n server_name'"
ok "nginx has a server block for $DOMAIN"

# ---------------------------------------------------------------------------
# Pre-flight: prove the challenge path works before Let's Encrypt tries it.
# ---------------------------------------------------------------------------
say "Preparing the ACME webroot"
mkdir -p "$WEBROOT/.well-known/acme-challenge"
# Must be traversable by the nginx worker user, which is not root.
chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
ok "$WEBROOT/.well-known/acme-challenge"

say "Checking DNS"
PUBLIC_IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
[ -n "$RESOLVED" ] || die "$DOMAIN does not resolve"
DNS_MISMATCH=0
if [ -n "$PUBLIC_IP" ] && ! printf '%s' "$RESOLVED" | grep -qw "$PUBLIC_IP"; then
    DNS_MISMATCH=1
    warn "$DOMAIN resolves to ${RESOLVED% } but this host is $PUBLIC_IP"
    warn "unless that address is a CDN/proxy in front of this host, the A record is wrong —"
    warn "the CA will validate against ${RESOLVED% }, not this machine, and a one-digit typo"
    warn "in the record is indistinguishable from a working setup until validation fails"
else
    ok "$DOMAIN -> ${RESOLVED% }"
fi

say "Pre-flight: fetching a test challenge over the public URL"
TOKEN="preflight-$(date +%s)-$RANDOM"
printf 'preflight-%s' "$TOKEN" > "$WEBROOT/.well-known/acme-challenge/$TOKEN"
chmod 644 "$WEBROOT/.well-known/acme-challenge/$TOKEN"
trap 'rm -f "$WEBROOT/.well-known/acme-challenge/$TOKEN"' EXIT

BODY="$(curl -fsS -m 15 --resolve "$DOMAIN:80:${RESOLVED%% *}" \
        "http://$DOMAIN/.well-known/acme-challenge/$TOKEN" 2>/dev/null || true)"
if [ "$BODY" != "preflight-$TOKEN" ]; then
    printf '\n' >&2
    warn "the challenge URL did not serve the test file. What answered instead:"
    { curl -sS -m 15 -i "http://$DOMAIN/.well-known/acme-challenge/$TOKEN" 2>&1 || true; } | head -12 | sed 's/^/      /' >&2
    {
        printf '\n    Usual causes, in order of likelihood:\n'
        if [ "$DNS_MISMATCH" = "1" ]; then
            printf '      - THE A RECORD POINTS AT ANOTHER MACHINE. %s resolves to\n' "$DOMAIN"
            printf '        %s, but this host is %s. The reply above came\n' "${RESOLVED% }" "$PUBLIC_IP"
            printf '        from that other machine, not from the nginx you just configured.\n'
            printf '        Fix the A record at your DNS provider and re-run.\n'
        fi
        printf '      - port 80 is blocked upstream (firewall / cloud security group)\n'
        printf '      - another vhost claims port 80 as default_server and wins;\n'
        printf '        find it with: nginx -T | grep -n default_server\n'
        printf '      - the domain points at a proxy in front of this host\n'
    } >&2
    die "aborting before contacting Let's Encrypt (a failed attempt here would count against the 5/hour limit)"
fi
ok "challenge path is publicly reachable"

# ---------------------------------------------------------------------------
# Certificate
# ---------------------------------------------------------------------------
LIVE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ -f "$LIVE" ] && [ "$FORCE" != "1" ] && openssl x509 -checkend 2592000 -noout -in "$LIVE" >/dev/null 2>&1; then
    say "Certificate already exists and is valid for >30 days — skipping issuance (FORCE=1 to override)"
else
    say "Requesting the certificate"
    CERTBOT_ARGS=(certonly --webroot -w "$WEBROOT" -d "$DOMAIN"
                  --non-interactive --agree-tos --keep-until-expiring
                  --deploy-hook "systemctl reload nginx")
    if [ -n "$EMAIL" ]; then
        CERTBOT_ARGS+=(-m "$EMAIL")
    else
        CERTBOT_ARGS+=(--register-unsafely-without-email)
        warn "no EMAIL set — no expiry warnings will be sent"
    fi
    if [ "$STAGING" = "1" ]; then
        # A separate cert-name so a staging rehearsal never overwrites the real
        # certificate's lineage.
        CERTBOT_ARGS+=(--staging --cert-name "$DOMAIN-staging")
        warn "STAGING=1: issuing an untrusted staging certificate"
    fi
    if [ "$FORCE" = "1" ]; then
        CERTBOT_ARGS+=(--force-renewal)
    fi

    certbot "${CERTBOT_ARGS[@]}" || die "certbot failed; see /var/log/letsencrypt/letsencrypt.log"
    ok "certificate issued"
fi

if [ "$STAGING" = "1" ]; then
    say "Staging run complete — the dry run works. Re-run without STAGING=1 for a real certificate."
    exit 0
fi

# ---------------------------------------------------------------------------
say "Installing the TLS config (stage 2)"
[ -f "$LIVE" ] || die "no certificate at $LIVE"
install_stage 1 "TLS"

# A reload is graceful: workers running the previous config keep serving until
# their in-flight connections drain, so probing immediately can still hit the
# old behaviour. Give the new workers a moment to take over.
say "Verifying from the outside"
REDIR=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    REDIR="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -m 15 "http://$DOMAIN/" || true)"
    case "$REDIR" in 30[128]\ *) break ;; esac
    sleep 1
done
case "$REDIR" in
    30[128]\ https://*) ok "http -> $REDIR" ;;
    *) warn "http://$DOMAIN/ -> $REDIR (expected a 301 to https; another server block may own port 80 for this name)" ;;
esac

CN="$(echo | openssl s_client -connect "${RESOLVED%% *}:443" -servername "$DOMAIN" 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null || true)"
printf '%s' "$CN" | grep -q "$DOMAIN" \
    || die "port 443 for $DOMAIN serves a different certificate ($CN) — another vhost is the 443 default_server and wins SNI"
ok "TLS serves the certificate for $DOMAIN"

# Verification must never abort the run: the certificate is already issued, and
# a non-200 here is an app problem, not a TLS one.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "https://$DOMAIN/healthz" || true)"
case "$CODE" in
    200) ok "https://$DOMAIN/healthz -> 200" ;;
    000) warn "https://$DOMAIN/healthz did not complete — the certificate above is correct, so this is"
         warn "usually a client-side trust issue (staging cert) or port 443 blocked from here" ;;
    *)   warn "https://$DOMAIN/healthz -> $CODE (TLS is fine; the app is not answering on 127.0.0.1:$APP_PORT)"
         warn "check: docker compose ps && curl -i localhost:$APP_PORT/healthz" ;;
esac

say "Done. Renewal is handled by certbot's systemd timer; it reloads nginx via the deploy hook."
printf '    Rehearse renewal any time with:  sudo certbot renew --dry-run\n\n' >&2
