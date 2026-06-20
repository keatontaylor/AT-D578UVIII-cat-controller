#!/usr/bin/env bash
#
# AnyTone AT-D578UV Bluetooth controller — one-shot installer.
#
# Usage (from a fresh machine):
#   curl -fsSL https://raw.githubusercontent.com/<USER>/<REPO>/main/install.sh | bash
#
# Or, from inside an existing clone:
#   ./install.sh
#
# What it does (idempotent — safe to re-run):
#   1. Installs system packages (Bluetooth, BlueALSA, ffmpeg, nginx, build tools).
#   2. Ensures Node.js >= 20 (via NodeSource if missing/too old).
#   3. Gets the source (uses the current clone, or clones it for you).
#   4. npm install + npm run build.
#   5. Writes a starter .env (from .env.example) if you don't have one.
#   6. Installs the isolated AnyTone BlueALSA HFP service and D-Bus policy.
#   7. Installs scoped sudoers rules needed by the unprivileged app service.
#   8. Installs + enables the AnyTone systemd service.
#   9. Installs + enables an nginx reverse-proxy site for the UI.
#
# Configurable via env vars:
#   ANYTONE_REPO_URL    git URL to clone from   (default below)
#   ANYTONE_BRANCH      branch to check out     (default: main)
#   ANYTONE_INSTALL_DIR where to clone if needed (default: <run-user-home>/anytone)
#   ANYTONE_RUN_USER    user the service should run as when installer is run as root
#   ANYTONE_NO_SERVICE=1   skip the AnyTone systemd service install/enable
#   ANYTONE_NO_BT_SETUP=1  skip the BlueALSA service/D-Bus setup
#   ANYTONE_NO_SUDOERS=1   skip scoped sudoers install
#   ANYTONE_NO_NGINX=1     skip nginx install/configure
#   ANYTONE_NGINX_SERVER_NAME server_name value (default: _)
#   ANYTONE_NGINX_LISTEN      listen directive value (default: 80)
#
set -euo pipefail

# ── Pretty output ───────────────────────────────────────────────────────────
if [ -t 1 ]; then BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { printf '\n%s==> %s%s\n' "$BOLD$GREEN" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s!!  %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die()  { printf '%sXX  %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ── Preconditions / user selection ──────────────────────────────────────────
command -v apt-get >/dev/null 2>&1 || die "This installer targets Debian / Raspberry Pi OS (apt). For other distros, install deps from docs/DEPENDENCIES.md and run scripts/setup.sh manually."

uname_s="$(uname -s)"
[ "$uname_s" = "Linux" ] || warn "This is $uname_s. The UI builds anywhere, but radio control (BlueZ + BlueALSA) is Linux-only."
if [ -r /etc/os-release ]; then
  . /etc/os-release
  debian_version="${VERSION_ID:-0}"
  debian_major="${debian_version%%.*}"
  case "$debian_major" in ''|*[!0-9]*) debian_major=0 ;; esac
  if [ "${ID:-}" = "debian" ] && [ "$debian_major" -gt 0 ] && [ "$debian_major" -lt 10 ]; then
    warn "Debian ${debian_version} is very old; Node ${NODE_MAJOR_MIN:-20} and bluez-alsa-utils may not be available from apt/NodeSource. The installer will try, but a current Debian/Raspberry Pi OS image is strongly recommended."
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  USER_NAME="${ANYTONE_RUN_USER:-${SUDO_USER:-}}"
  [ -n "$USER_NAME" ] || die "When running as root, set ANYTONE_RUN_USER=<user> so the service is not installed as root."
  id "$USER_NAME" >/dev/null 2>&1 || die "ANYTONE_RUN_USER '$USER_NAME' does not exist. Create it first."
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root."
  USER_NAME="${ANYTONE_RUN_USER:-$(id -un)}"
  id "$USER_NAME" >/dev/null 2>&1 || die "ANYTONE_RUN_USER '$USER_NAME' does not exist."
fi

USER_GROUP="$(id -gn "$USER_NAME")"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$USER_HOME" ] || die "Could not determine home directory for $USER_NAME."

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

as_user() {
  if [ "$(id -un)" = "$USER_NAME" ]; then "$@"; else sudo -H -u "$USER_NAME" "$@"; fi
}

# ── Tunables ────────────────────────────────────────────────────────────────
REPO_URL="${ANYTONE_REPO_URL:-https://github.com/sourceunknown/anytone.git}"
BRANCH="${ANYTONE_BRANCH:-main}"
INSTALL_DIR="${ANYTONE_INSTALL_DIR:-$USER_HOME/anytone}"
NODE_MAJOR_MIN=20
NGINX_SITE_NAME="${ANYTONE_NGINX_SITE_NAME:-anytone}"
NGINX_SERVER_NAME="${ANYTONE_NGINX_SERVER_NAME:-_}"
NGINX_LISTEN="${ANYTONE_NGINX_LISTEN:-80}"
NGINX_DISABLE_DEFAULT="${ANYTONE_NGINX_DISABLE_DEFAULT:-1}"

# ── 1. System packages ──────────────────────────────────────────────────────
step "Installing system packages (apt)"
as_root apt-get update -y
# bluez            -> rfcomm / bluetoothctl (SPP control link)
# bluez-alsa-utils -> bluealsa / bluealsa-cli (HFP audio link)
# ffmpeg           -> system fallback for audio (the app also ships ffmpeg-static)
# nginx            -> LAN-facing reverse proxy for the loopback-bound UI
# build-essential, python3, pkg-config -> compile native npm modules (serialport, wrtc)
as_root apt-get install -y \
  sudo git ca-certificates curl gnupg apt-transport-https \
  dbus systemd rfkill \
  bluez bluez-alsa-utils \
  ffmpeg alsa-utils libasound2-dev \
  nginx \
  build-essential python3 pkg-config

# ── 2. Node.js >= 20 ────────────────────────────────────────────────────────
node_ok=0
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${cur:-0}" -ge "$NODE_MAJOR_MIN" ]; then
    node_ok=1
    info "Node $(node -v) already present."
  else
    warn "Node $(node -v) is older than v${NODE_MAJOR_MIN}; upgrading via NodeSource."
  fi
fi
if [ "$node_ok" -ne 1 ]; then
  step "Installing Node.js ${NODE_MAJOR_MIN}.x (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
  as_root apt-get install -y nodejs
  info "Installed Node $(node -v), npm $(npm -v)."
fi

# ── 3. Get the source ───────────────────────────────────────────────────────
# Is this script running from inside an existing checkout?
is_repo() { [ -f "$1/package.json" ] && [ -d "$1/app" ]; }

REPO=""
self="${BASH_SOURCE[0]:-}"
if [ -n "$self" ] && [ -f "$self" ]; then
  sdir="$(cd "$(dirname "$self")" && pwd)"
  if is_repo "$sdir"; then REPO="$sdir"; fi
fi
# Also accept being run from within a clone (e.g. `bash install.sh`).
if [ -z "$REPO" ] && is_repo "$PWD"; then REPO="$PWD"; fi

if [ -n "$REPO" ]; then
  step "Using existing checkout: $REPO"
else
  step "Fetching source into $INSTALL_DIR"
  if is_repo "$INSTALL_DIR"; then
    info "Updating existing clone (git pull)."
    as_user git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed; continuing with existing tree."
  else
    [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] && \
      die "$INSTALL_DIR exists and is not empty. Set ANYTONE_INSTALL_DIR or clear it."
    as_user git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
      || die "Clone failed. Check ANYTONE_REPO_URL ($REPO_URL) / ANYTONE_BRANCH ($BRANCH)."
  fi
  REPO="$INSTALL_DIR"
fi
REPO="$(cd "$REPO" && pwd)"

# ── 4. Install deps + build ─────────────────────────────────────────────────
step "Installing npm dependencies (this compiles native modules; may take a while on a Pi)"
# Force a dev install so build tooling (nuxt/vue-tsc/typescript) is available.
as_user env NODE_ENV=development npm --prefix "$REPO" install

step "Building the UI (npm run build)"
as_user npm --prefix "$REPO" run build

# ── 5. Starter .env ─────────────────────────────────────────────────────────
if [ -f "$REPO/.env" ]; then
  info ".env already present — leaving it untouched."
else
  step "Creating $REPO/.env from .env.example"
  as_user cp "$REPO/.env.example" "$REPO/.env"
  warn "Edit $REPO/.env and set ANYTONE_BT_ADDR to your radio's BT MAC (or leave it to auto-discover by name)."
fi

# Load local config for generated service/sudoers names. Keep this after .env
# creation so defaults from .env.example are available on a first run.
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi

# ── 6. BlueALSA HFP audio setup ─────────────────────────────────────────────
if [ "${ANYTONE_NO_BT_SETUP:-0}" = "1" ]; then
  warn "ANYTONE_NO_BT_SETUP=1 — skipping BlueALSA audio setup."
elif [ "$uname_s" = "Linux" ]; then
  step "Configuring isolated BlueALSA HFP instance (scripts/setup.sh)"
  ANYTONE_RUN_USER="$USER_NAME" bash "$REPO/app/scripts/setup.sh"
else
  warn "Not Linux — skipping BlueALSA audio setup."
fi

# ── 7. scoped sudoers for service runtime ───────────────────────────────────
if [ "${ANYTONE_NO_SUDOERS:-0}" = "1" ]; then
  warn "ANYTONE_NO_SUDOERS=1 — skipping sudoers install. Connect may fail unless sudoers is configured separately."
elif [ "$uname_s" = "Linux" ]; then
  step "Installing scoped sudoers for Bluetooth runtime commands"
  RFCOMM_BIN="$(command -v rfcomm || true)"
  SYSTEMCTL_BIN="$(command -v systemctl || true)"
  [ -n "$RFCOMM_BIN" ] || die "rfcomm not found after package install."
  [ -n "$SYSTEMCTL_BIN" ] || die "systemctl not found after package install."
  RFCOMM_ID="${ANYTONE_RFCOMM_ID:-10}"
  RFCOMM_PATH="${ANYTONE_RFCOMM_PATH:-/dev/rfcomm${RFCOMM_ID}}"
  SPP_CHANNEL="${ANYTONE_SPP_CHANNEL:-2}"
  BLUEALSA_SUFFIX="${ANYTONE_BLUEALSA_DBUS-anytone}"
  BLUEALSA_SERVICE="${ANYTONE_BLUEALSA_SERVICE:-bluealsa-${BLUEALSA_SUFFIX:-anytone}.service}"
  sudoers_tmp="$(mktemp)"
  cat >"$sudoers_tmp" <<EOF
# Managed by AnyTone installer. Lets the unprivileged app service bring up the
# radio control link and start only its isolated BlueALSA instance.
Defaults:${USER_NAME} !requiretty
${USER_NAME} ALL=(root) NOPASSWD: ${RFCOMM_BIN} release ${RFCOMM_ID}, ${RFCOMM_BIN} connect ${RFCOMM_PATH} * ${SPP_CHANNEL}, ${SYSTEMCTL_BIN} start ${BLUEALSA_SERVICE}
EOF
  as_root install -m 0440 "$sudoers_tmp" /etc/sudoers.d/anytone
  rm -f "$sudoers_tmp"
  as_root visudo -cf /etc/sudoers.d/anytone >/dev/null
  info "Installed /etc/sudoers.d/anytone for $USER_NAME."
else
  warn "Not Linux — skipping sudoers install."
fi

# ── 8. systemd service (autostart on boot) ──────────────────────────────────
if [ "${ANYTONE_NO_SERVICE:-0}" = "1" ]; then
  warn "ANYTONE_NO_SERVICE=1 — skipping systemd service install."
elif [ "$uname_s" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  step "Installing systemd service 'anytone' (runs as $USER_NAME, starts on boot)"
  ANYTONE_SYSTEMD_BLUEALSA_SERVICE="${ANYTONE_BLUEALSA_SERVICE:-bluealsa-${ANYTONE_BLUEALSA_DBUS:-anytone}.service}"
  as_root tee /etc/systemd/system/anytone.service >/dev/null <<EOF
[Unit]
Description=AnyTone AT-D578UV Bluetooth controller
After=network-online.target bluetooth.target ${ANYTONE_SYSTEMD_BLUEALSA_SERVICE}
Wants=network-online.target ${ANYTONE_SYSTEMD_BLUEALSA_SERVICE}

[Service]
Type=simple
User=${USER_NAME}
Group=${USER_GROUP}
WorkingDirectory=${REPO}/app
EnvironmentFile=-${REPO}/.env
Environment=NODE_ENV=production
ExecStart=${REPO}/app/scripts/run-anytone.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable anytone.service
  as_root systemctl restart anytone.service
  info "Service enabled. Check it with:  systemctl status anytone   |   journalctl -u anytone -f"
else
  warn "No systemd — skipping service. Start manually with: $REPO/app/scripts/run-anytone.sh"
fi

# ── 9. nginx reverse proxy ──────────────────────────────────────────────────
if [ "${ANYTONE_NO_NGINX:-0}" = "1" ]; then
  warn "ANYTONE_NO_NGINX=1 — skipping nginx install/configuration."
elif [ "$uname_s" = "Linux" ] && command -v nginx >/dev/null 2>&1; then
  step "Installing nginx reverse proxy site '${NGINX_SITE_NAME}'"
  UI_PORT="${PORT:-3030}"
  as_root mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  as_root tee "/etc/nginx/sites-available/${NGINX_SITE_NAME}.conf" >/dev/null <<EOF
# Managed by AnyTone installer. Proxies the LAN-facing HTTP site to the loopback
# Nuxt UI. Put TLS/auth in front of this if exposing beyond a trusted LAN.
server {
    listen ${NGINX_LISTEN};
    server_name ${NGINX_SERVER_NAME};

    access_log /var/log/nginx/${NGINX_SITE_NAME}.access.log;
    error_log  /var/log/nginx/${NGINX_SITE_NAME}.error.log;

    location /api/events {
        proxy_pass http://127.0.0.1:${UI_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location /api/audio/stream {
        proxy_pass http://127.0.0.1:${UI_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location /api/raw-ws {
        proxy_pass http://127.0.0.1:${UI_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:${UI_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
  as_root ln -sfn "../sites-available/${NGINX_SITE_NAME}.conf" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}.conf"
  if [ "$NGINX_DISABLE_DEFAULT" = "1" ]; then
    as_root rm -f /etc/nginx/sites-enabled/default
  fi
  as_root nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable nginx.service
    as_root systemctl reload nginx.service 2>/dev/null || as_root systemctl restart nginx.service
  else
    as_root service nginx reload 2>/dev/null || as_root service nginx restart
  fi
  info "nginx site enabled at http://<this-host>/ (proxying 127.0.0.1:${UI_PORT})."
else
  warn "nginx was not installed/found — skipping reverse proxy configuration."
fi

# ── Done ────────────────────────────────────────────────────────────────────
PORT_HINT="${PORT:-3030}"
cat <<EOF

${BOLD}${GREEN}Done.${RESET}

Source:   ${REPO}
Config:   ${REPO}/.env   (set ANYTONE_BT_ADDR; see docs/CONFIGURATION.md)
Local UI: http://localhost:${PORT_HINT}/   (Nuxt, bound to loopback by default)
nginx:    http://<this-host>/              (reverse proxy, unless skipped)

Next steps:
  1. Edit ${REPO}/.env — at minimum ANYTONE_BT_ADDR (or rely on name auto-discovery).
  2. If this is the first install, log out and back in (or reboot) so your new
     'bluetooth', 'audio', and 'dialout' group membership takes effect for
     interactive use.
  3. The service is already running. Re-launch after edits with:
        sudo systemctl restart anytone
     Or run in the foreground for development:
        cd ${REPO} && npm run dev

nginx exposes the UI on port ${NGINX_LISTEN} by default. Add TLS/auth before exposing
it outside a trusted LAN (docs/SECURITY_REVIEW.md).
EOF
