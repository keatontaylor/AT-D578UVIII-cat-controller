# Orange Pi 3 LTS (Allwinner H6) setup

`install.sh` targets Raspberry Pi OS. On an Orange Pi 3 LTS the app installs and the radio
pairs, but **no audio flows** in either direction until the Bluetooth hardware is changed. This
is what it took to get working audio.

## Why the onboard Bluetooth doesn't work

The Orange Pi 3 LTS's onboard Wi-Fi/Bluetooth chip is a **Unisoc UWE5622** (sold as "AW859A").
In `dmesg` it shows up as the Unisoc "Marlin" driver:

```
WCN: start_marlin [MARLIN_BLUETOOTH]
```

This app carries voice over HFP: the radio's audio travels as Bluetooth SCO (call audio), and
BlueALSA reads and writes it over the HCI link between the chip and the CPU. The UWE5622 doesn't
reliably route SCO over HCI. Pairing, the RFCOMM control link and the HFP connection all work,
but no voice samples ever reach BlueALSA. There's no documented command to change that on this
chip. (Broadcom chips can be switched with `hcitool cmd 0x3f 0x1c …`, which is what Raspberry Pi
OS's `bthelper` does at boot.)

**Fix:** use a USB Bluetooth dongle whose chip routes SCO over HCI, and disable the onboard one.

## Hardware

**TP-Link UB500** USB Bluetooth 5.0 adapter, which uses the Realtek **RTL8761BU** chip.

## Steps

All commands run as root on the Pi.

### 1. Disable the onboard Bluetooth

The onboard chip is brought up by `sprd-bluetooth.service`:

```bash
systemctl list-units | grep -e blue -e hciattach   # shows sprd-bluetooth.service
systemctl disable --now sprd-bluetooth.service
reboot
```

The app uses the **first** adapter BlueZ reports. With the onboard chip disabled, the dongle is
the only adapter and comes up as `hci0`. Check that only the USB adapter is listed:

```bash
hciconfig -a
```

### 2. Install the RTL8761BU firmware

Out of the box the dongle has no firmware file, and `dmesg` shows:

```
bluetooth hci0: Direct firmware load for rtl_bt/rtl8761bu_fw.bin failed with error -2
Bluetooth: hci0: RTL: firmware file rtl_bt/rtl8761bu_fw not found
```

Without it the chip falls back to its built-in ROM code, which is unreliable for SCO. Download
the firmware and config files from the kernel's linux-firmware repository:

```bash
mkdir -p /lib/firmware/rtl_bt && cd /lib/firmware/rtl_bt
for f in rtl8761bu_fw.bin rtl8761bu_config.bin; do
  [ -f "$f" ] || curl -fsSLO "https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/rtl_bt/$f"
done
modprobe -r btusb && modprobe btusb   # or unplug and replug the dongle
dmesg | grep -i rtl                   # expect "RTL: fw version 0x…" and no "not found"
```

### 3. Restart the stack and re-pair

Pairings are stored per adapter, so the radio has to be paired again with the dongle:

```bash
systemctl restart bluetooth bluealsa-anytone
systemctl --user -M <user>@ restart anytone-v2
```

In the UI, go to **Scan → Pair → Connect**. Then check that the HFP PCMs are on the dongle:

```bash
bluealsa-cli -B anytone list-pcms
# /org/bluealsa/hci0/dev_XX_XX_XX_XX_XX_XX/hfphf/source
# /org/bluealsa/hci0/dev_XX_XX_XX_XX_XX_XX/hfphf/sink
```

## Troubleshooting

### `br-connection-refused` on Connect

Watch the connection with `btmon`. If ACL, `Auth Complete: Success` and the RFCOMM channel all
succeed, followed by

```
bluetoothd: src/profile.c:new_conn_reply() Hands-Free unit..
```

then the radio and the pairing are fine, and the **local HFP handler (BlueALSA) rejected the
connection**. Check:

```bash
journalctl -u bluetooth -b | grep -A1 new_conn_reply          # BlueZ's full message, including the error
grep ExecStart /etc/systemd/system/bluealsa-anytone.service   # no stale "-i hciN" for an adapter that's gone
systemctl is-active bluealsa.service                          # the system-wide BlueALSA can take the HF role
journalctl -u bluealsa-anytone -b | tail -20
```

- **The unit has a stale `-i hciN`:** remove it, run `systemctl daemon-reload`, then
  `systemctl restart bluealsa-anytone`.
- **The system `bluealsa.service` is active:** it may have registered the Hands-Free role first.
  Run `systemctl disable --now bluealsa.service`, then `systemctl restart bluealsa-anytone`.

### Still no audio on receive

`sudo btmon` while the radio receives should show `SCO Data` packets. An eSCO
`Synchronous Connect Complete` with no SCO data means the controller isn't routing SCO over HCI:
the onboard chip is still the one being used, or the dongle is running ROM firmware.


