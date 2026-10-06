# Container Egress Isolation

**Status:** Shipped in the repository; installed per host with the steps below.
It replaces the control retired in
[egress-control-retirement.md](egress-control-retirement.md) (issue #189).

## Threat Model and Scope

A compromised Besedy container (web, jobs API, Prefect worker or server,
ColBERT, a GPU backend, a database) must not be able to pivot to:

- the host itself, on any of its addresses and ports: LAN, tailnet, libvirt,
  Docker bridge gateways, and ports the host publishes for other containers;
- the LAN (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`);
- the tailnet (`100.64.0.0/10`) and link-local (`169.254.0.0/16`);
- anything over IPv6.

Outbound internet stays open: OAuth, Web Push, OpenRouter and NVIDIA APIs,
Hugging Face model downloads, and the npm registry for the OAuth mock.

The policy covers **every** container on a Besedy network, in production,
development, and test alike: dev and test containers run the same code and
downloaded models as production. Containers that join only non-Besedy
networks (for example Trivy in `web/scripts/security-update-check.sh` on
Docker's default bridge) are out of scope.

## Design

Two parts, both static:

1. **Fixed bridge names.** Every network Besedy creates uses a Linux bridge
   named `br-bsdy*`:

   | Network | Bridge | Set by |
   | --- | --- | --- |
   | `besedy-internal` | `br-bsdy-int` | `scripts/docker_network.sh` |
   | `besedy-prefect` | `br-bsdy-pfct` | `scripts/docker_network.sh` |
   | `besedy-production_default` | `br-bsdy-wprod` | `scripts/run_web_compose.sh` |
   | `besedy-development_default` | `br-bsdy-wdev` | `scripts/run_web_compose.sh` |
   | `besedy-test_default` | `br-bsdy-wtest` | `scripts/run_web_compose.sh` |
   | isolated `besedy-test-*` instances | `br-bsdy-<crc>` | `scripts/run_web_compose.sh` |
   | `besedy-jobs-{prod,dev,test}_default` | `br-bsdy-j{prod,dev,test}` | jobs compose files |
   | `besedy-rag-services_default` | `br-bsdy-rag` | `rag-services/docker-compose.yml` |
   | `besedy-backends_default` | `br-bsdy-bknd` | `backends/docker-compose.yml` |

   Subnets stay auto-allocated; the policy never refers to them. Every owned
   network sets `enable_ipv6: false`. `tests/test_egress_isolation.py` fails if
   a compose network lacks a fixed name.

2. **One nftables table**, `inet besedy_egress`
   ([`web/setup/egress/besedy-egress.nft`](../../web/setup/egress/besedy-egress.nft)),
   loaded by `besedy-container-egress.service`. Its single chain hooks
   `prerouting` at priority `mangle` and, for packets arriving on `br-bsdy*`:
   drops all IPv6; accepts replies (`ct state established,related`); drops new
   connections to any local address of the host (`fib daddr type local`); drops
   new connections to the private ranges above.

Why this shape:

- **Nothing can bypass it.** In nftables a drop in any base chain is final; an
  accept elsewhere only ends that chain. Tailscale's `ts-forward` accept for
  tailnet traffic and ufw's SSH accept in `INPUT` both run in other tables and
  cannot let a dropped packet through. Docker, ufw, Tailscale, and libvirt
  never write to this table.
- **Every attached network is covered.** The match is on the input interface
  prefix, so it does not matter which network carries a container's default
  route, whether a container sits on several networks, or whether a process
  binds a socket to another interface (`SO_BINDTODEVICE`).
- **Host ports are covered in one place.** `prerouting` sees traffic to the
  host before the `INPUT`/`FORWARD` split and before DNAT, so the same rule
  stops SSH, SMB, NFS, and the host's published container ports.
- **Inbound keeps working.** Replies to connections opened into a container
  (cloudflared to the production web port, the LAN to dev web, the host CLI to
  ColBERT) are `established` and pass.
- **Container-to-container traffic is unaffected.** Containers on the same
  network talk over the bridge without reaching IP `prerouting` while
  `br_netfilter` is not loaded, which is the case on this host. Docker's own
  network isolation is not touched.
- **DNS needs no exception.** Docker's embedded resolver forwards queries from
  the host's network namespace, not through the container's bridge.
- **Atomic, persistent, no reconciler.** `nft -f` replaces the table in one
  transaction and changes nothing if the file does not parse. The table
  survives Docker restarts, `ufw reload`, and network recreation (it matches
  names, not existing interfaces); the unit reloads it at boot.

### Services That Used to Reach the Host

- **ColBERT** joined `besedy-internal`; web uses
  `RAG_COLBERT_URL=http://besedy-colbert:8192/query`. Its host port binds to
  `127.0.0.1` for the host CLI. Searching from outside Besedy goes through the
  MCP server (`find_transcript_mentions`), which applies catalog ACLs.
- **`host.docker.internal`** is gone from web and the Prefect workers. A dev
  Prefect worker can no longer call a dev web app running outside Compose; use
  the dev web container.
- The host ingest worker and host CLI run on the host and are not affected.

## Installing on a Host

Run once per host, during a maintenance window. Containers lose access to the
host and LAN as soon as the table loads, so ColBERT must already be reachable
over `besedy-internal` (step 2) before production web is checked.

1. Update the env files that set `RAG_COLBERT_URL` (the resolved
   `web.env.prod`, `web.env.dev`, `web.env.test`) to
   `http://besedy-colbert:8192/query`. They override the compose default.
2. Recreate every Besedy network so it gets its bridge name. Bridge names are
   set only at creation, and the shared networks can only be removed once every
   container has left them. From the deploy checkout of each stack:

   ```bash
   # Each `down` also removes that project's own network.
   just prod-down; just dev-down; just test-down
   just jobs-prod-down; just jobs-dev-down; just jobs-test-down   # where running
   just prefect-down
   just rag-services-down                # from the checkout that owns besedy-colbert
   # Shared and run-only networks have no owning project:
   docker network rm besedy-internal besedy-prefect besedy-backends_default
   docker network ls --filter name=besedy   # expect no output
   ```

   Then bring the stacks back with the usual `up`/`deploy` recipes; they create
   the networks with the new names. `scripts/docker_network.sh ensure` warns
   about any shared network that still has an old `br-<id>` bridge.
3. Install and start the policy:

   ```bash
   sudo install -D -m 0644 web/setup/egress/besedy-egress.nft /etc/besedy/besedy-egress.nft
   sudo install -m 0644 web/setup/egress/besedy-container-egress.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now besedy-container-egress.service
   ```

4. Verify: `just egress-check`, then web search, MCP search, sign-in, and a
   deep-search job.

To change the policy later, install the new file and run
`sudo systemctl reload besedy-container-egress.service`.

**Rollback:** `sudo systemctl disable --now besedy-container-egress.service`
deletes the table. The bridge names and the ColBERT move can stay.

## Verification

`just egress-check` (also run by `just prod-status`) runs
[`scripts/egress-check.sh`](../../scripts/egress-check.sh) as root. For every
running container on a `besedy*` network it:

- fails if any of the container's networks lacks a `br-bsdy*` bridge or has
  IPv6 enabled;
- connects from the container's network namespace with `nsenter` (no tools
  needed in the read-only images) and expects a **timeout** for: SSH on the
  host's LAN address and on every attached network's gateway, TCP 53 on the
  LAN router, libvirt and the host's tailnet address, Tailscale's
  `100.100.100.100`, and a port the host publishes on all interfaces. A refused
  or accepted connection means the packet got past the policy;
- expects an internet address (`1.1.1.1:443`) to connect.

Afterwards the `host` and `private` drop counters must be non-zero, so a
policy that matches nothing (the failure of the retired control) cannot
report healthy. The script exits non-zero on any failure.

## Assumptions and Residual Risk

- Recorded against Docker 29.0.1, Docker Compose v5.6.0, nftables 1.0.9, and
  iptables 1.8.10 (nf_tables backend).
- `br_netfilter` must stay unloaded. If it is loaded (for example by Docker
  for a network with inter-container communication disabled), traffic between
  containers on one network would also be dropped; `egress-check` fails in
  that case.
- Containers on a shared network still reach each other: dev and test web can
  query the shared ColBERT and talk to every jobs API on `besedy-internal`, and
  every Prefect client reaches the shared Prefect server. These are deliberate
  east-west paths, not host or LAN access.
- Internet egress is not allowlisted. Exfiltration over the internet is out of
  scope; restricting it would need an egress proxy.
