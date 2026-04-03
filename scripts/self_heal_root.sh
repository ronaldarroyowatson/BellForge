#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "self_heal_root.sh must run as root" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: self_heal_root.sh <action>" >&2
  exit 2
fi

action="$1"

case "${action}" in
  enable-client)
    systemctl enable --now bellforge-client.service
    ;;
  restart-client)
    systemctl restart bellforge-client.service
    ;;
  restart-lightdm)
    systemctl restart lightdm.service
    ;;
  reboot)
    /sbin/reboot
    ;;
  reset-gpu)
    sh -c "echo 1 > /sys/class/drm/*/reset 2>/dev/null || true"
    ;;
  clear-framebuffer)
    sh -c "fbset -c 16 2>/dev/null || true"
    ;;
  force-hdmi-mode)
    sh -c "xrandr --output HDMI-1 --mode 1920x1080 --rate 60 2>/dev/null || true && systemctl restart lightdm"
    ;;
  cold-reboot)
    /bin/sh -c "sleep 2 && /sbin/reboot"
    ;;
  *)
    echo "Unknown self-heal action: ${action}" >&2
    exit 2
    ;;
esac
