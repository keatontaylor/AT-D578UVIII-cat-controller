#!/usr/bin/env bash
# Idempotent first-run setup for the AnyTone controller's Bluetooth audio.
#
# Installs an ISOLATED BlueALSA instance dedicated to this app — its own D-Bus name
# (org.bluealsa.anytone), serving ONLY the HFP hands-free profile. It coexists with
# any system BlueALSA (e.g. the distro's A2DP daemon) and never touches it, so we
# use Bluetooth audio without interfering with whatever else the daemon serves.
#
# Safe to re-run. Needs sudo for the system unit + D-Bus policy.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

# Match the runtime launcher: local .env values should also shape the managed
# BlueALSA unit, otherwise audio tuning in .env will not affect the daemon.
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi

SUFFIX="${ANYTONE_BLUEALSA_DBUS-anytone}"
if [ -n "$SUFFIX" ]; then
  DBUS_NAME="org.bluealsa.${SUFFIX}"
  SERVICE="bluealsa-${SUFFIX}.service"
  BLUEALSA_DBUS_ARGS="-B ${SUFFIX}"
  BLUEALSA_CLI_ARGS=(-B "$SUFFIX")
  POLICY_SUFFIX="$SUFFIX"
else
  DBUS_NAME="org.bluealsa"
  SERVICE="bluealsa-anytone.service"
  BLUEALSA_DBUS_ARGS=""
  BLUEALSA_CLI_ARGS=()
  POLICY_SUFFIX="default"
fi
USER_NAME="${ANYTONE_RUN_USER:-${SUDO_USER:-$USER}}"
BLUEALSA_BIN="$(command -v bluealsa || echo /usr/bin/bluealsa)"
KEEPALIVE="${ANYTONE_BLUEALSA_KEEPALIVE:-30}"
LOGLEVEL="${ANYTONE_BLUEALSA_LOGLEVEL:-warning}"
CODEC="${ANYTONE_BLUEALSA_CODEC:-CVSD}"
IO_RT_PRIORITY="${ANYTONE_BLUEALSA_IO_RT_PRIORITY:-20}"
CODEC_ARGS=""
if [ -n "$CODEC" ]; then CODEC_ARGS="-c ${CODEC}"; fi
RT_ARGS=""
if [ -n "$IO_RT_PRIORITY" ] && [ "$IO_RT_PRIORITY" != "0" ]; then RT_ARGS="--io-rt-priority=${IO_RT_PRIORITY}"; fi

echo "==> AnyTone BT audio setup (isolated BlueALSA instance: ${DBUS_NAME})"

if [ ! -x "$BLUEALSA_BIN" ]; then
  echo "BlueALSA not found. Install it first, e.g.:" >&2
  echo "  sudo apt install bluez-alsa-utils    # Debian/Raspberry Pi OS" >&2
  exit 1
fi

# 1. Group membership: BlueZ (bluetooth), BlueALSA client access (audio), and
#    rfcomm/USB serial devices (dialout).
for grp in bluetooth audio dialout; do
  if ! getent group "$grp" >/dev/null 2>&1; then
    echo "==> group '$grp' is not present; skipping"
    continue
  fi
  if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx "$grp"; then
    echo "==> adding $USER_NAME to '$grp' group (re-login required to take effect)"
    sudo usermod -aG "$grp" "$USER_NAME"
  fi
done

# 2. D-Bus policy: allow clients to talk to our suffixed instance. The upstream
#    bluealsa policy already allows OWNING org.bluealsa.* (own_prefix), but its
#    send rules are for the exact name 'org.bluealsa' only.
echo "==> installing D-Bus policy for ${DBUS_NAME}"
sudo tee "/etc/dbus-1/system.d/anytone-${POLICY_SUFFIX}.conf" >/dev/null <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="root">
    <allow send_destination="${DBUS_NAME}"/>
  </policy>
  <policy group="audio">
    <allow send_destination="${DBUS_NAME}"/>
  </policy>
</busconfig>
EOF

# 3. Managed, reboot-safe systemd unit for our isolated instance. No -i (serves all
#    adapters, so it survives hci reindexing); HFP only; restart on failure.
#    Keep the prior proven audio behavior: long keep-alive, quiet logs, and CVSD
#    8 kHz PCM. Raise BlueALSA's IO threads to RT priority to reduce SCO gaps.
echo "==> installing ${SERVICE}"
sudo tee "/etc/systemd/system/${SERVICE}" >/dev/null <<EOF
[Unit]
Description=BlueALSA HFP instance for AnyTone controller (${DBUS_NAME})
Requires=bluetooth.service dbus.service
After=bluetooth.service dbus.service

[Service]
Type=dbus
BusName=${DBUS_NAME}
ExecStart=${BLUEALSA_BIN} ${BLUEALSA_DBUS_ARGS} -p hfp-hf ${CODEC_ARGS} --keep-alive=${KEEPALIVE} ${RT_ARGS} --loglevel=${LOGLEVEL}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

echo "==> reloading systemd + D-Bus, enabling service"
sudo systemctl daemon-reload
sudo systemctl reload dbus 2>/dev/null || sudo systemctl reload dbus.service 2>/dev/null || true
sudo systemctl enable "$SERVICE"
sudo systemctl restart "$SERVICE"
sleep 1

echo "==> verifying ${DBUS_NAME}"
if bluealsa-cli "${BLUEALSA_CLI_ARGS[@]}" status >/dev/null 2>&1; then
  echo "OK: ${DBUS_NAME} is up and reachable."
else
  echo "NOTE: instance started but client access not yet permitted." >&2
  echo "If you were just added to the 'audio' group, log out/in (or reboot) and re-run." >&2
fi
echo "Done. The app will use ${DBUS_NAME} for HFP audio."
