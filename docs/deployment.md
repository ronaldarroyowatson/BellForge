# Deployment Guide

## Prerequisites

| Component | Where it runs | Requirements |
|-----------|--------------|--------------|
| FastAPI backend | Central server (Linux/Windows/Mac/Docker) | Python 3.11+, network reachable by all Pis |
| Updater agent | Each Raspberry Pi | Python 3.11+, systemd |
| Signage client | Each Raspberry Pi | Chromium, X11, openbox |

---

## 1. Central Server Setup

### Install the backend

```bash
git clone https://github.com/YOUR_ORG/BellForge.git
cd BellForge
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### Generate the first manifest

```bash
python scripts/generate_manifest.py
```

### Run (development)

```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

### Run (production — systemd)

Create `/etc/systemd/system/bellforge-backend.service`:

```ini
[Unit]
Description=BellForge Backend
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/bellforge
ExecStart=/opt/bellforge/.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 2
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bellforge-backend
```

### Verify

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/version
curl http://localhost:8000/api/manifest
```

---

## 2. Raspberry Pi Setup

### One-command install

```bash
export BELLFORGE_SERVER_URL=http://YOUR_SERVER_IP:8000
export BELLFORGE_DEVICE_ID=pi-room-101
curl -sSL https://raw.githubusercontent.com/YOUR_ORG/BellForge/main/scripts/bootstrap.sh | sudo bash
```

The script will install everything and reboot the Pi.

### What bootstrap.sh does

1. Installs Python 3.11, Chromium, git, openbox, unclutter.
2. Creates the `bellforge` system user.
3. Clones the repo into `/opt/bellforge`.
4. Creates a virtualenv and installs updater dependencies.
5. Writes `/opt/bellforge/config/settings.json` with your `SERVER_URL` and `DEVICE_ID`.
6. Installs and enables `bellforge-updater.service`, `bellforge-client.service`, and `bellforge-file-server.service`.
7. Configures autologin and Openbox autostart for kiosk mode.
8. Reboots.

### Service overview (on the Pi)

| Service | Purpose |
|---------|---------|
| `bellforge-updater` | Polls backend for updates; self-healing |
| `bellforge-file-server` | Serves `client/` on `localhost:8080` via Python http.server |
| `bellforge-client` | Chromium kiosk pointing at `localhost:8080` |

---

## 3. Managing the Schedule

Edit `config/schedule.json` on the server:

```json
{
  "school_name": "My School",
  "timezone": "America/Chicago",
  "periods": [
    {"name": "1st Period", "start": "08:00", "end": "08:55", "type": "class"},
    ...
  ]
}
```

Then push to `main`; Pis will pick up the new schedule within one poll interval.

---

## 4. Releasing an Update

### Automatic (recommended)

1. Make your changes on a feature branch.
2. Merge to `main`.
3. GitHub Actions automatically bumps the patch version, regenerates the manifest, commits, and tags.
4. Pis auto-update within the next poll interval (default 5 minutes).

### Manual

```bash
# Bump patch version and regenerate manifest
python scripts/bump_version.py

# Or bump minor/major
python scripts/bump_version.py minor

# Commit and push
git add config/version.json config/manifest.json
git commit -m "chore: release v$(python -c "import json; print(json.load(open('config/version.json'))['version'])")"
git push origin main
```

### Force immediate update on all Pis

```bash
curl -X POST http://YOUR_SERVER:8000/api/broadcast \
  -H "Content-Type: application/json" \
  -d '{"pi_ips": ["192.168.1.101", "192.168.1.102", "192.168.1.103"]}'
```

---

## 5. Pi Network Requirements

| Direction | Protocol | Port | Purpose |
|-----------|----------|------|---------|
| Pi → Server | HTTP | 8000 | Update polling, schedule fetch |
| Server → Pi | HTTP | 8765 | Broadcast trigger (optional) |
| Pi internal | HTTP | 8080 | File server → Chromium |
