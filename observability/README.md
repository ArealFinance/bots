# Areal Observability Stack

The Areal observability stack monitors the Areal Finance protocol and its operational infrastructure. Phase 20 delivers the foundation: Prometheus time-series database, Alertmanager alert routing, Grafana dashboards, and host/endpoint metrics exporters. The stack runs on a dedicated Fornex VPS co-located with the validator and bot infrastructure, with public read-only access at **https://status.areal.finance**.

This is open-source infrastructure as part of Areal's commitment to protocol transparency (Solana Colosseum hackathon).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Fornex VPS (co-located: validator + bots + observability)   │
│                                                              │
│  solana-test-validator                                       │
│                                                              │
│  6 bots (Phase 21):                                          │
│   merkle-publisher   /metrics :9101 (127.0.0.1)              │
│   revenue-crank      /metrics :9102 (127.0.0.1)              │
│   pool-rebalancer    /metrics :9103 (127.0.0.1)              │
│   convert-and-fund   /metrics :9104 (127.0.0.1)              │
│   yield-claim-crank  /metrics :9105 (127.0.0.1)              │
│   nexus-manager      /metrics :9106 (127.0.0.1)              │
│   chain-invariants   /metrics :9201 (127.0.0.1) [Phase 22]   │
│                                                              │
│  node_exporter :9100 (127.0.0.1)                             │
│  blackbox_exporter :9115 (127.0.0.1)                         │
│                                                              │
│  Prometheus :9090 (127.0.0.1)  — 15d / 5GB retention         │
│       ├──► Alertmanager :9093 ──► Telegram bot               │
│       └──► Grafana :3000 ──► cloudflared ──► status.areal.   │
│                                              finance         │
└──────────────────────────────────────────────────────────────┘

External (off-host):
  UptimeRobot         ──► panel.areal.finance, app.areal.finance, rpc.areal.finance
  Telegram            ──◄ Alertmanager outbound (no inbound)
  Cloudflare          ──► DDoS + DNS + tunnel termination
```

All metrics endpoints bind `127.0.0.1` only. Grafana is the single externally-exposed component, served through Cloudflare's cloudflared tunnel. No public ports on the VPS itself.

## Quickstart for Operators

**You are deploying observability infrastructure. Do not start here without VPS root access and the secrets listed below.**

### 1. Get the Bootstrap Script

The deployment automation lives in the **meta-repo** (sibling repository, not in this `/bots/` directory):

```bash
# On your local machine
git clone https://github.com/ArealFinance/meta.git
cd meta/scripts/observability

# Read the full runbook
cat ../../INFRASTRUCTURE.md  # Section: "Observability"
```

The script is `bootstrap-fornex.sh` and handles:
- Docker & docker-compose installation
- Environment templating (envsubst)
- Port audit verification (`ss -tlnp`)
- Container bring-up
- Health checks

### 2. Prepare Environment Secrets

Copy `.env.example` from this directory to your VPS:

```bash
# On the VPS
ssh root@your-fornex-vps

# Copy the template
curl -sL https://raw.githubusercontent.com/ArealFinance/bots/main/observability/.env.example \
  > /etc/areal-obs/.env

# Secure it
chmod 600 /etc/areal-obs/.env

# Edit in your values (Telegram bot token, RPC endpoint URL, etc.)
nano /etc/areal-obs/.env
```

**Every variable must be filled in.** The bootstrap script validates:
- No empty values in `.env` (after sourcing)
- Template files rendered correctly
- Port bindings correct (via `ss -tlnp` audit)

### 3. Run the Bootstrap Script

```bash
# On the VPS, from the meta-repo checkout
cd /path/to/meta
sudo bash scripts/observability/bootstrap-fornex.sh
```

The script will:
1. Read `/etc/areal-obs/.env`
2. Render `.template.yml` → `.yml` files (envsubst)
3. Bring up all 5 services via `docker-compose up -d`
4. Wait for health checks
5. Print final status

### 4. Verify & Access

```bash
# On the VPS
docker-compose -f /path/to/bots/observability/docker-compose.yml ps
docker-compose logs -f prometheus  # or alertmanager, grafana, etc.

# Locally, via VPS SSH tunnel (or through Cloudflare)
ssh -L 3000:127.0.0.1:3000 root@your-fornex-vps
# Now http://localhost:3000 → Grafana
```

Public read-only access: **https://status.areal.finance** (Viewer-only, Explore disabled).

### 5. Add Bot Metrics (Phase 21)

When bot instrumentation lands, uncomment the `bots` scrape job in `prometheus/prometheus.template.yml`:

```yaml
  - job_name: bots
    static_configs:
      - targets:
          - 'localhost:9101'   # merkle-publisher
          - 'localhost:9102'   # revenue-crank
          # ... etc.
```

Reload Prometheus: `curl -X POST http://localhost:9090/-/reload`

## File Layout

```
bots/observability/
├── .env.example                              — env template; copy to /etc/areal-obs/.env on VPS
├── README.md                                 — this file
├── docker-compose.template.yml               — 5 services: Prometheus, Alertmanager, Grafana, 2 exporters
├── prometheus/
│   ├── prometheus.template.yml               — scrape config; Phase 21/22 jobs commented out
│   └── rules/
│       └── infra.yml                         — 4 base alert rules (disk, memory, TLS, blackbox)
├── alertmanager/
│   └── alertmanager.template.yml             — Telegram receivers; severity-based routing
└── grafana/
    ├── grafana.template.ini                  — anonymous Viewer + Explore disabled
    ├── provisioning/
    │   ├── datasources/
    │   │   └── datasources.template.yml      — Prometheus datasource (uid: prometheus)
    │   └── dashboards/
    │       └── dashboards.yml                — dashboard provisioner (NOT a template)
    └── dashboards/
        └── infra.json                        — Infrastructure dashboard (CPU/RAM/disk/network/probes;
                                                 mounted to /etc/grafana/dashboard-files/)
```

All `.template.*` files are rendered by the bootstrap script via `envsubst`. Only `.example` and non-template files are committed.

## Port Allocation (Locked)

| Port | Service | Bind | Phase | Notes |
|---|---|---|---|---|
| 9090 | Prometheus | 127.0.0.1 | 20 | Time-series DB; 15d / 5GB retention |
| 9093 | Alertmanager | 127.0.0.1 | 20 | Telegram routing; no public port |
| 9100 | node_exporter | 127.0.0.1 | 20 | Host metrics (CPU, RAM, disk, network) |
| 9115 | blackbox_exporter | 127.0.0.1 | 20 | HTTP/HTTPS probes for panel, app, RPC |
| 3000 | Grafana | 127.0.0.1 | 20 | Publicly exposed only via cloudflared tunnel |
| 9101 | merkle-publisher | 127.0.0.1 | 21 | Bot metrics (uncomment in Phase 21) |
| 9102 | revenue-crank | 127.0.0.1 | 21 | Bot metrics |
| 9103 | pool-rebalancer | 127.0.0.1 | 21 | Bot metrics |
| 9104 | convert-and-fund | 127.0.0.1 | 21 | Bot metrics |
| 9105 | yield-claim-crank | 127.0.0.1 | 21 | Bot metrics |
| 9106 | nexus-manager | 127.0.0.1 | 21 | Bot metrics |
| 9201 | chain-invariants | 127.0.0.1 | 22 | Exporter for protocol invariants (Phase 22) |

All ports bind `127.0.0.1` exclusively. The bootstrap script audits this with `ss -tlnp`.

## Multi-Environment Awareness

The stack is **multi-env-aware from Phase 20**, even though only one environment is deployed at a time.

Three identity labels propagate via Prometheus `external_labels` to every series scraped:

| Label | Plane | Values |
|---|---|---|
| `env` | business | `testnet` \| `devnet` \| `mainnet` |
| `cluster` | physical | `fornex` \| `prod-hetzner` \| ... |
| `network` | data | `solana-test-validator` \| `devnet` \| `mainnet` |

`env` and `network` are decoupled deliberately: a `testnet` deployment may point at `solana-test-validator` (local) or `devnet` (Solana devnet); a `mainnet-staging` could point at `mainnet` while still being routed as a non-urgent alert tier.

**Per-cluster deployment matrix:**

| Cluster | `AREAL_ENV` | `AREAL_CLUSTER` | `SOLANA_NETWORK` | When |
|---|---|---|---|---|
| Fornex VPS (current) | `testnet` | `fornex` | `solana-test-validator` | Phase 20+ |
| Future devnet stage | `devnet` | _your-name_ | `devnet` | When devnet bots ship |
| Future production | `mainnet` | _your-name_ | `mainnet` | When mainnet bots ship |

Each cluster runs its OWN observability stack (own Prometheus, own Alertmanager, own Grafana) with `external_labels` set accordingly. To compare envs in one Grafana, configure multiple Prometheus datasources (one per cluster) — no federation needed at small scale.

Alertmanager routing can use the `env` label to differentiate severity tiers:
- `severity=critical AND env=mainnet` → urgent channel + page
- `severity=critical AND env=testnet` → quiet dev channel
- (Routing tree expanded in Phase 24.)

## Phase Roadmap

- **Phase 20** (just landed): Foundation stack — templates, base alerts (disk/memory/TLS/blackbox), Infra dashboard.
- **Phase 21**: Bot instrumentation — add `prom-client` to 6 cranks; "Areal — Protocol Health" and "Bot Deep Dive" dashboards; bot-specific alerts.
- **Phase 22**: Chain invariants exporter as `bots/chain-invariants/` workspace; status badges endpoint for shields.io; "Chain Invariants" dashboard. New alerts: `MerkleRootStale`, `AuthorityDrift`.
- **Phase 23**: Frontend Sentry integration in `dashboard/` and `app/`.
- **Phase 24**: Polish observability contract — Mintlify operator guide, runbooks, metrics catalog, acceptance chaos tests.

## Security Guarantees

- **All `/metrics` endpoints bind `127.0.0.1` only.** The bootstrap script audits this and will fail if any exporter listens on `0.0.0.0`.
- **No secrets in this repository.** Real values (Telegram bot token, Grafana password, RPC endpoint) live in `/etc/areal-obs/.env` on the VPS, `chmod 600` and not version-controlled.
- **`.env.example` is validated to contain only empty values.** Bootstrap script checks this before rendering real configs.
- **Grafana anonymous access is Viewer-only** with **Explore globally disabled.** Public users cannot modify dashboards, run arbitrary queries, or access admin functions.
- **Pre-commit hooks** (via Husky in meta-repo): gitleaks for secret scanning, custom lint preventing literal hostnames in `*.template.yml` files.
- **Cloudflared tunnel** handles DDoS protection, certificate management, and TLS termination. No public ports on the VPS itself.

## For Colosseum Reviewers & External Observers

The Areal observability contract is open-source. Full configuration — alert rules, Grafana dashboards, exporter source code — lives in this directory and in `bots/chain-invariants/` (Phase 22). Live protocol status is at **https://status.areal.finance** with anonymous read-only access (Viewer role only, no Explore).

Any independent operator can deploy the same stack against the protocol's RPC endpoint by copying `.env.example`, filling in secrets, and running the bootstrap script from the meta-repo. The stack is containerized for easy replication on any Linux host.

## References

- **Deployment automation**: `scripts/observability/bootstrap-fornex.sh` and operator runbook `INFRASTRUCTURE.md` (meta-repo)
- **Design & decisions**: `plan/observability-plan.md` and Phase 20 section in `plan/integration-plan.md` (meta-repo, private but referenced for in-repo readers)
- **Live status**: https://status.areal.finance
- **Code**: https://github.com/ArealFinance/bots/tree/main/observability
- **Hackathon**: https://www.colosseum.org

---

**Last updated:** Phase 20 foundation  
**Maintainer:** Areal Finance team  
**License:** MIT
