# BellForge Unified Authentication Backend

## Overview

BellForge now supports a unified, inheritance-based authentication model for:
- Web app
- Browser extension
- Device clients (Raspberry Pi signage)
- Server-side API and device registry

Authentication uses external identity providers as the root of trust. BellForge verifies provider ID tokens server-side, then issues BellForge-scoped JWTs for user and device access.

## Supported Providers

- Google (OIDC)
- Microsoft (OIDC)
- Apple (OIDC)
- GitHub (optional)

The provider verifier is abstraction-based and accepts new providers by adding config + verifier metadata.

## Environment Configuration

Required runtime env vars:

```bash
# Core BellForge token settings
BELLFORGE_JWT_SECRET=<strong-random-secret>
BELLFORGE_JWT_ISSUER=bellforge-server
BELLFORGE_ACCESS_TOKEN_TTL_SECONDS=900
BELLFORGE_REFRESH_TOKEN_TTL_SECONDS=2592000
BELLFORGE_DEVICE_TOKEN_TTL_SECONDS=3600
BELLFORGE_PAIRING_TTL_SECONDS=300
BELLFORGE_QR_TTL_SECONDS=600

# Identity provider settings (per provider)
BELLFORGE_GOOGLE_CLIENT_ID=<google-client-id>
BELLFORGE_GOOGLE_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs

BELLFORGE_MICROSOFT_CLIENT_ID=<microsoft-client-id>
BELLFORGE_MICROSOFT_JWKS_URL=https://login.microsoftonline.com/common/discovery/v2.0/keys

BELLFORGE_APPLE_CLIENT_ID=<apple-service-id>
BELLFORGE_APPLE_JWKS_URL=https://appleid.apple.com/auth/keys

# Optional GitHub OIDC/JWT-compatible bridge
BELLFORGE_GITHUB_CLIENT_ID=<github-client-id>
BELLFORGE_GITHUB_JWKS_URL=<your-github-oidc-jwks-url>

# Storage override (defaults to config/auth_registry.json)
BELLFORGE_AUTH_STORE_PATH=/opt/bellforge/config/auth_registry.json
```

Development-only setting for tests:

```bash
BELLFORGE_AUTH_ALLOW_INSECURE_STUB_TOKENS=1
```

Stub token format:

```text
stub:<provider>:<subject>:<email>
```

## Data Model (JSON Registry)

The storage backend is JSON (`config/auth_registry.json`). The registry uses these top-level collections:

- `users`
- `provider_index`
- `refresh_sessions`
- `revoked_jti`
- `devices`
- `pairing_sessions`
- `automode.controllers`
- `automode.pending`
- `automode.history`

Device record fields include:
- `id`
- `owner_user_id`
- `permissions`
- `org_id`
- `classroom_id`
- `auth_source`
- `linked_via`
- `network_id`
- `status`
- `revoked`

## API Endpoints

### Auth

- `POST /api/auth/login`
  - Input: provider + provider ID token
  - Output: BellForge access + refresh tokens

- `POST /api/auth/refresh`
  - Input: BellForge refresh token
  - Output: rotated access + refresh token pair

- `POST /api/auth/logout`
  - Input: bearer access token and/or refresh token
  - Output: token revocation confirmation

- `POST /api/auth/verify`
  - Input: bearer token or explicit token payload
  - Output: validated BellForge token claims

### Devices

- `POST /api/devices/register`
- `GET /api/devices/list`
- `POST /api/devices/revoke`
- `POST /api/devices/transfer`
- `POST /api/devices/heartbeat`

### Pairing and QR onboarding

- `POST /api/devices/pairing/init`
  - Device requests a short-lived pairing code and QR token.

- `POST /api/devices/pairing/claim-code`
  - User claims device with single-use numeric code.

- `POST /api/devices/pairing/claim-qr`
  - User claims device by submitting signed QR payload.

- `POST /api/devices/pairing/status`
  - Device polls pairing status and receives device token after approval.

### AutoMode

- `POST /api/automode/activate`
- `POST /api/automode/discovery/report`
  - Input includes discovery `source`: `mdns`, `broadcast`, `heartbeat`, or `db-queue`
- `GET /api/automode/pending`
- `POST /api/automode/decide`
- `GET /api/automode/history`

## Device Inheritance Model

1. User logs in via OIDC provider.
2. BellForge creates/updates user identity.
3. User registers or pairs a device.
4. Device receives BellForge device token linked to owner user.
5. Device inherits user permissions/org/classroom scope.
6. Server enforces every request using BellForge JWT + registry state.

Transfer and revocation:
- Transfer changes `owner_user_id` and records history.
- Revocation marks device `revoked=true`; subsequent device requests fail.

## Pairing Code Security

- Code length: 8 digits
- Single-use: yes
- TTL: default 5 minutes
- Stored as HMAC digest (not plaintext)
- Rate-limited at init and claim endpoints

## QR Onboarding Security

- QR payload is a BellForge-signed short-lived token
- No secret profile data embedded
- Includes nonce and session binding
- Expires automatically
- Supports delayed/offline scan-to-claim flow while token is valid

## AutoMode Security Rules

- Never overwrites already-authenticated devices
- Requires user approval (`/automode/decide`) before auto-linking
- Maintains pending queue and history audit trail
- Network scope constrained by controller activation context

## Frontend Integration

Examples live in:
- `client/js/auth_integration_examples.js`
- `scripts/device_bootstrap_auth.py`
- `client/automode.html`
- `client/js/automode.js`

These cover:
- Web login and refresh
- Extension login and token persistence
- Device bootstrap with pairing code + QR token polling
- Auto-reconnect behavior after 401 responses
- AutoMode dashboard components (status, discovered list, pending approvals, history, and manual override)

## Security Best Practices Implemented

- HTTPS expected end-to-end
- Provider token verified server-side
- BellForge claims never accepted from clients directly
- Access tokens are short-lived
- Refresh tokens are rotated on use
- Token revocation list enforced
- Pairing flow is single-use + TTL + rate-limited

## Deployment Checklist

1. Configure provider client IDs + JWKS URLs.
2. Set a strong `BELLFORGE_JWT_SECRET`.
3. Use HTTPS reverse proxy (nginx/Caddy/ALB).
4. Restrict CORS to known origins in production.
5. Back up `config/auth_registry.json`.
6. Run auth tests before each release.
