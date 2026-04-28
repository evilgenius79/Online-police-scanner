#!/usr/bin/env bash
# Bootstrap the scanner on Orange Pi 4 Pro (A733) running Armbian/Ubuntu.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $EUID -eq 0 ]]; then
  echo "Run as your normal user, not root. (sudo will be invoked as needed.)"
  exit 1
fi

echo "==> apt deps"
sudo apt-get update
sudo apt-get install -y \
  python3-venv python3-pip \
  libportaudio2 portaudio19-dev \
  libatlas-base-dev

echo "==> audio group"
if ! id -nG "$USER" | grep -qw audio; then
  sudo usermod -a -G audio "$USER"
  echo "   added $USER to 'audio' group; log out and back in for it to take effect"
fi

echo "==> venv"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip wheel
pip install -r requirements.txt

echo
echo "Done. Next:"
echo "  source .venv/bin/activate"
echo "  python -m scanner devices       # find your USB mic index"
echo "  SCANNER_INPUT_DEVICE=N python -m scanner run"
