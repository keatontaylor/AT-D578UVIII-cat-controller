#!/usr/bin/env bash
#
# AnyTone AT-D578UVIII Bluetooth controller — one-shot installer (v2).
#
# Usage (from a fresh machine):
#   curl -fsSL https://raw.githubusercontent.com/keatontaylor/AT-D578UVIII-cat-controller/main/install.sh | bash
#
# Or, from inside an existing clone:
#   ./install.sh
#
# What it does (idempotent — safe to re-run):
#   1. Installs system packages (BlueZ, BlueALSA, ALSA, Avahi, optional direwolf/nginx).
#   2. Ensures Node.js >= 20 (via NodeSource if missing/too old).
#   3. Gets the source (uses the current clone, or clones it for you).
#   4. npm install + npm run build.
#   5. Installs the isolated BlueALSA HFP instance (org.bluealsa.anytone) + D-Bus policy.
#   6. Installs ONE scoped sudoers rule (start that BlueALSA service, nothing else).
#   7. Installs + enables the app as a USER systemd service (anytone-v2) with linger,
#      so it starts at boot without running as root.
#   8. (Optional) Installs an nginx HTTPS reverse proxy for the UI.
#
# Configurable via env vars:
#   ANYTONE_REPO_URL     git URL to clone from    (default below)
#   ANYTONE_BRANCH       branch to check out      (default: main)
#   ANYTONE_INSTALL_DIR  where to clone if needed (default: <run-user-home>/anytone)
#   ANYTONE_RUN_USER     user the service runs as (default: the invoking user)
#   ANYTONE_API_PORT     app port                 (default: 8080)
#   ANYTONE_BASE_PATH    URL subpath              (default: /anytone-v2)
#   ANYTONE_NO_SERVICE=1   skip the app systemd service
#   ANYTONE_NO_BT_SETUP=1  skip the BlueALSA service/D-Bus setup
#   ANYTONE_NO_SUDOERS=1   skip the sudoers rule
#   ANYTONE_NO_NGINX=1     skip nginx install/configure
#   ANYTONE_NO_PACKET=1    skip installing direwolf (packet TNC stays available if present)
#   ANYTONE_NGINX_SERVER_NAME  server_name value  (default: _)
#   ANYTONE_NGINX_TLS=0        plain HTTP only    (default: TLS on, self-signed)
#   ANYTONE_NGINX_TLS_DAYS     self-signed validity in days (default: 3650)
#
set -eu
# pipefail is bash/ksh only — enable it where available, but stay POSIX so `curl … | sh`
# (any /bin/sh: dash, ash) runs this one-shot without a "Bad substitution" / literal-escape mess.
( set -o pipefail ) 2>/dev/null && set -o pipefail || true

# ── Pretty output ───────────────────────────────────────────────────────────
# printf-generated ESC (POSIX) instead of $'\033' ANSI-C quoting (bash-only).
if [ -t 1 ]; then
  ESC="$(printf '\033')"
  BOLD="${ESC}[1m"; GREEN="${ESC}[32m"; YELLOW="${ESC}[33m"; RED="${ESC}[31m"; RESET="${ESC}[0m"
else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { printf '\n%s==> %s%s\n' "$BOLD$GREEN" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s!!  %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die()  { printf '%sXX  %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ── Preconditions / user selection ──────────────────────────────────────────
command -v apt-get >/dev/null 2>&1 || die "This installer targets Debian / Raspberry Pi OS (apt). For other distros install the packages listed in step 1 by hand."
[ "$(uname -s)" = "Linux" ] || die "Radio control needs Linux (BlueZ + BlueALSA)."

USER_NAME="${ANYTONE_RUN_USER:-${SUDO_USER:-$(id -un)}}"
[ "$USER_NAME" = "root" ] && die "Refusing to run the app as root. Set ANYTONE_RUN_USER."
id "$USER_NAME" >/dev/null 2>&1 || die "User '$USER_NAME' does not exist."
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
USER_UID="$(id -u "$USER_NAME")"

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
as_user() { if [ "$(id -un)" = "$USER_NAME" ]; then "$@"; else as_root runuser -u "$USER_NAME" -- "$@"; fi; }
# systemctl --user for the target user (works whether or not we ARE that user)
user_systemctl() {
  if [ "$(id -un)" = "$USER_NAME" ]; then systemctl --user "$@"
  else as_root systemctl --user -M "${USER_NAME}@" "$@"; fi
}

REPO_URL="${ANYTONE_REPO_URL:-https://github.com/keatontaylor/AT-D578UVIII-cat-controller.git}"
BRANCH="${ANYTONE_BRANCH:-main}"
INSTALL_DIR="${ANYTONE_INSTALL_DIR:-$USER_HOME/anytone}"
API_PORT="${ANYTONE_API_PORT:-8080}"
# Default mount = ROOT: the app serves straight at http://<ip>:PORT/ . Set ANYTONE_BASE_PATH
# to a subpath (e.g. /anytone-v2) when serving several apps behind one host. Trailing slashes
# are stripped so both "/foo" and "/foo/" normalize to "/foo" (and "/" → "" = root).
BASE_PATH="${ANYTONE_BASE_PATH:-}"
BASE_PATH="$(printf '%s' "$BASE_PATH" | sed 's:/*$::')"
BLUEALSA_SUFFIX="${ANYTONE_BLUEALSA_DBUS:-anytone}"
BLUEALSA_SERVICE="bluealsa-${BLUEALSA_SUFFIX}.service"

# ── nginx: OPT-IN (default = direct IP) ─────────────────────────────────────
# The app serves plain HTTP on :PORT. Browsers only allow MICROPHONE capture (PTT voice) over
# HTTPS, so without the nginx TLS proxy the mic/PTT won't work (RX listen still does). Honor an
# explicit env choice; otherwise ASK (reading /dev/tty so it works even under `curl … | sh`);
# no terminal → default to no proxy (direct IP).
if [ "${ANYTONE_NO_NGINX:-0}" = "1" ]; then WANT_NGINX=0
elif [ "${ANYTONE_NGINX:-0}" = "1" ]; then WANT_NGINX=1
elif [ -r /dev/tty ]; then
  printf '\n%s?? %s%s\n' "$YELLOW" "Install an nginx HTTPS reverse proxy?" "$RESET"
  printf '    Without it the app is reachable at http://<this-host>:%s/ over plain HTTP —\n' "$API_PORT"
  printf '    but the microphone (PTT voice) needs HTTPS, so mic/PTT will NOT work. RX audio still will.\n'
  printf '    Install nginx + a self-signed HTTPS proxy now? [y/N] '
  read ans </dev/tty || ans=""
  case "$ans" in [Yy]*) WANT_NGINX=1 ;; *) WANT_NGINX=0 ;; esac
else
  WANT_NGINX=0
fi

# ── 1. System packages ──────────────────────────────────────────────────────
# bluez            -> BlueZ stack + sdptool (SPP channel discovery)
# bluez-alsa-utils -> bluealsa daemon + bluealsa-cli (HFP voice link)
# alsa-utils       -> arecord/aplay (audio capture/playback plumbing)
# avahi-utils      -> Bonjour advertisement for the packet TNC (optional feature)
# direwolf         -> packet soundcard modem (optional feature)
# nginx + openssl  -> LAN-facing HTTPS reverse proxy (optional)
step "Installing system packages"
as_root apt-get update -qq
PKGS="git curl ca-certificates dbus rfkill bluez bluez-alsa-utils alsa-utils avahi-utils"
[ "${ANYTONE_NO_PACKET:-0}" = "1" ] || PKGS="$PKGS direwolf"
[ "$WANT_NGINX" = "1" ] && PKGS="$PKGS nginx openssl"
# shellcheck disable=SC2086
as_root apt-get install -y $PKGS

# ── 2. Node.js >= 20 ────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  step "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
  as_root apt-get install -y nodejs
else
  info "Node $(node -v) is fine."
fi

# ── 3. Source checkout ──────────────────────────────────────────────────────
is_repo() { [ -f "$1/package.json" ] && [ -f "$1/src/main.ts" ]; }
REPO=""
# $0 (POSIX) locates the script when run as a file (./install.sh, sh install.sh); when piped
# (curl … | sh) $0 is the shell name and [ -f ] is false → fall through to PWD / clone.
self="$0"
if [ -n "$self" ] && [ -f "$self" ]; then
  sdir="$(cd "$(dirname "$self")" && pwd)"
  if is_repo "$sdir"; then REPO="$sdir"; fi
fi
if [ -z "$REPO" ] && is_repo "$PWD"; then REPO="$PWD"; fi
if [ -n "$REPO" ]; then
  step "Using existing checkout: $REPO"
else
  step "Fetching source into $INSTALL_DIR"
  if is_repo "$INSTALL_DIR"; then
    info "Updating existing clone (git pull)."
    as_user git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed; continuing with the existing tree."
  else
    [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] && \
      die "$INSTALL_DIR exists and is not empty. Set ANYTONE_INSTALL_DIR or clear it."
    as_user git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
      || die "Clone failed. Check ANYTONE_REPO_URL ($REPO_URL) / ANYTONE_BRANCH ($BRANCH)."
  fi
  REPO="$INSTALL_DIR"
fi
REPO="$(cd "$REPO" && pwd)"

# ── 4. npm install + build ──────────────────────────────────────────────────
step "Installing npm dependencies (native modules; may take a while on a Pi)"
as_user env CI=1 npm --prefix "$REPO" install
step "Building the UI"
# ANYTONE_BASE_PATH is baked into the SPA at build time (vite base) — pass the chosen one through.
as_user env CI=1 ANYTONE_BASE_PATH="$BASE_PATH" npm --prefix "$REPO" run build

# ── 5. Isolated BlueALSA HFP instance ───────────────────────────────────────
# A private daemon (org.bluealsa.<suffix>) serving HFP-HF/CVSD ONLY, so the system
# BlueALSA / PipeWire keeps A2DP for everything else and the radio's voice link is ours.
if [ "${ANYTONE_NO_BT_SETUP:-0}" = "1" ]; then
  warn "ANYTONE_NO_BT_SETUP=1 — skipping BlueALSA setup."
else
  step "Installing $BLUEALSA_SERVICE (org.bluealsa.$BLUEALSA_SUFFIX)"
  as_root tee "/etc/systemd/system/$BLUEALSA_SERVICE" >/dev/null <<EOF
[Unit]
Description=BlueALSA HFP instance for AnyTone controller (org.bluealsa.$BLUEALSA_SUFFIX)
Requires=bluetooth.service dbus.service
After=bluetooth.service dbus.service

[Service]
Type=dbus
BusName=org.bluealsa.$BLUEALSA_SUFFIX
ExecStart=/usr/bin/bluealsa -B $BLUEALSA_SUFFIX -p hfp-hf -c CVSD --keep-alive=30 --io-rt-priority=20 --loglevel=warning
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  as_root tee "/etc/dbus-1/system.d/bluealsa-$BLUEALSA_SUFFIX.conf" >/dev/null <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="root">
    <allow own="org.bluealsa.$BLUEALSA_SUFFIX"/>
    <allow send_destination="org.bluealsa.$BLUEALSA_SUFFIX"/>
  </policy>
  <policy group="audio">
    <allow send_destination="org.bluealsa.$BLUEALSA_SUFFIX"/>
  </policy>
</busconfig>
EOF
  as_root usermod -aG audio,bluetooth "$USER_NAME" 2>/dev/null || true
  as_root systemctl daemon-reload
  as_root systemctl enable "$BLUEALSA_SERVICE"
  as_root systemctl restart "$BLUEALSA_SERVICE"
fi

# ── 6. Scoped sudoers ───────────────────────────────────────────────────────
# The app (unprivileged) may start ITS OWN BlueALSA instance if it isn't running — that
# single command is the entire sudo surface.
if [ "${ANYTONE_NO_SUDOERS:-0}" = "1" ]; then
  warn "ANYTONE_NO_SUDOERS=1 — skipping sudoers rule."
else
  step "Installing scoped sudoers rule"
  SYSTEMCTL_BIN="$(command -v systemctl)"
  sudoers_tmp="$(mktemp)"
  cat >"$sudoers_tmp" <<EOF
# Managed by the AnyTone installer. The app service may start only its own
# isolated BlueALSA instance.
Defaults:${USER_NAME} !requiretty
${USER_NAME} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} start ${BLUEALSA_SERVICE}
EOF
  as_root install -m 0440 "$sudoers_tmp" /etc/sudoers.d/anytone
  rm -f "$sudoers_tmp"
  as_root visudo -cf /etc/sudoers.d/anytone >/dev/null
fi

# ── 7. App service (systemd USER unit + linger) ─────────────────────────────
if [ "${ANYTONE_NO_SERVICE:-0}" = "1" ]; then
  warn "ANYTONE_NO_SERVICE=1 — skipping the app service. Run manually: cd $REPO && npm start"
else
  step "Installing user service anytone-v2 (starts at boot via linger)"
  UNIT_DIR="$USER_HOME/.config/systemd/user"
  as_user mkdir -p "$UNIT_DIR"
  unit_tmp="$(mktemp)"
  cat >"$unit_tmp" <<EOF
[Unit]
Description=AnyTone D578 controller v2 — Fastify + Vite SPA, single process
After=network.target bluetooth.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=ANYTONE_API_PORT=$API_PORT
Environment=ANYTONE_API_HOST=0.0.0.0
Environment=ANYTONE_BASE_PATH=$BASE_PATH
Environment=ANYTONE_BLUEALSA_DBUS=$BLUEALSA_SUFFIX
ExecStart=$(command -v node) --import tsx src/main.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  as_root install -m 0644 -o "$USER_NAME" "$unit_tmp" "$UNIT_DIR/anytone-v2.service"
  rm -f "$unit_tmp"
  # Secrets (e.g. Cloudflare TURN) go in a mode-600 drop-in, never the unit or repo:
  as_user mkdir -p "$UNIT_DIR/anytone-v2.service.d"
  if [ ! -f "$UNIT_DIR/anytone-v2.service.d/turn.conf" ]; then
    drop_tmp="$(mktemp)"
    cat >"$drop_tmp" <<'EOF'
# Optional: Cloudflare TURN credentials for WebRTC audio across hostile NATs.
# Uncomment and fill in, then: systemctl --user restart anytone-v2
# [Service]
# Environment=ANYTONE_CF_TURN_KEY_ID=your-key-id
# Environment=ANYTONE_CF_TURN_API_TOKEN=your-api-token
EOF
    as_root install -m 0600 -o "$USER_NAME" "$drop_tmp" "$UNIT_DIR/anytone-v2.service.d/turn.conf"
    rm -f "$drop_tmp"
  fi
  as_root loginctl enable-linger "$USER_NAME"
  user_systemctl daemon-reload
  user_systemctl enable anytone-v2 || true
  user_systemctl restart anytone-v2
  info "Check it with:  systemctl --user status anytone-v2"
fi

# ── 8. nginx reverse proxy (HTTPS) ──────────────────────────────────────────
if [ "$WANT_NGINX" != "1" ]; then
  warn "No nginx proxy — the app listens on :$API_PORT directly (http://<this-host>:$API_PORT${BASE_PATH}/)."
  warn "Microphone / PTT voice needs HTTPS; over plain HTTP only RX listen works. Re-run with ANYTONE_NGINX=1 to add it."
else
  step "Installing nginx site 'anytone'"
  SERVER_NAME="${ANYTONE_NGINX_SERVER_NAME:-_}"
  TLS="${ANYTONE_NGINX_TLS:-1}"
  LISTEN_BLOCK="listen 80;"
  TLS_BLOCK=""
  if [ "$TLS" = "1" ]; then
    as_root mkdir -p /etc/nginx/ssl
    if [ ! -f /etc/nginx/ssl/anytone.crt ]; then
      as_root openssl req -x509 -nodes -newkey rsa:2048 -days "${ANYTONE_NGINX_TLS_DAYS:-3650}" \
        -keyout /etc/nginx/ssl/anytone.key -out /etc/nginx/ssl/anytone.crt \
        -subj "/CN=anytone" >/dev/null 2>&1
    fi
    LISTEN_BLOCK="listen 80;
  location / { return 301 https://\$host\$request_uri; }
}
server {
  server_name $SERVER_NAME;
  listen 443 ssl;
  ssl_certificate     /etc/nginx/ssl/anytone.crt;
  ssl_certificate_key /etc/nginx/ssl/anytone.key;"
  fi
  # Root mount (default): one plain `location /`. Subpath mount: proxy the prefix WITHOUT
  # stripping it (the app is subpath-native), plus redirects for the bare prefix and root.
  if [ -z "$BASE_PATH" ]; then
    LOCATION_BLOCK="  location / { proxy_pass http://127.0.0.1:${API_PORT}; }"
  else
    LOCATION_BLOCK="  location = ${BASE_PATH} { return 302 ${BASE_PATH}/; }
  location ${BASE_PATH}/ { proxy_pass http://127.0.0.1:${API_PORT}; }
  location = / { return 302 ${BASE_PATH}/; }"
  fi
  as_root tee /etc/nginx/sites-available/anytone >/dev/null <<EOF
# Managed by the AnyTone installer.
# Proxies the app on :${API_PORT}$( [ -n "$BASE_PATH" ] && printf ' (subpath-native at %s/ — prefix NOT stripped)' "$BASE_PATH" ).
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  ''      close;
}
server {
  server_name $SERVER_NAME;
  $LISTEN_BLOCK

  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header Upgrade \$http_upgrade;
  proxy_set_header Connection \$connection_upgrade;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;

$LOCATION_BLOCK
}
EOF
  as_root ln -sf /etc/nginx/sites-available/anytone /etc/nginx/sites-enabled/anytone
  as_root nginx -t
  as_root systemctl reload nginx
fi

step "Done"
if [ "$WANT_NGINX" = "1" ]; then
  info "Open:  https://<this-host>${BASE_PATH}/   (HTTPS — mic/PTT voice works)"
else
  info "Open:  http://<this-host>:${API_PORT}${BASE_PATH}/   (plain HTTP — RX audio only; mic/PTT needs HTTPS, re-run with ANYTONE_NGINX=1)"
fi
info "Put the radio in pairing mode (Menu → Bluetooth → Pairing), then Scan → Pair → Connect."
info "Logs:  systemctl --user status anytone-v2"
