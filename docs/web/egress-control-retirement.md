# Docker LAN Egress Control Retirement

**Status:** Retired on 2026-09-17. Besedy does not currently install or claim a
host firewall rule that blocks containers from reaching private LAN addresses.

This record explains what the removed control attempted, why it did not provide
the protection described in the security documentation, and what a future
replacement must address.

## What the Control Attempted

The repository previously shipped:

- `web/setup/egress/iptables-egress.sh`, which added rules to Docker's
  `DOCKER-USER` chain;
- `web/setup/egress/besedy-egress.service`, which ran the script at boot; and
- setup documentation that described container-to-LAN traffic as blocked.

The rules were intended to block traffic from a Docker subnet to the RFC 1918
private ranges while allowing traffic between containers and outbound internet
access required for OAuth.

## Why It Did Not Work

The script matched one hardcoded source subnet, `172.22.0.0/16`. Docker Compose
default networks are recreated by operations such as `docker compose down` and
may receive a different subnet the next time they are created. On the host
reviewed in September 2026, none of the active Besedy networks used the
hardcoded subnet.

The firewall rules and systemd service therefore remained present and appeared
healthy, but real container traffic did not match them. The setup had no check
that compared the configured subnet with Docker's live networks, so this
failure was silent. Starting the service only at boot also did not address
network recreation while Docker itself remained running.

This was worse than an explicit absence of the control: the documentation and
green service status created false confidence that LAN access was blocked.

## Why Dynamic Reconciliation Was Rejected

[PR #123](https://github.com/lukleh/besedy/pull/123) explored discovering every
Docker bridge subnet and continuously reconciling firewall rules. The approach
was closed rather than merged because reliable enforcement required too much
custom operational machinery:

- Docker network create/destroy events needed a long-running watcher plus a
  periodic timer to cover missed events.
- Multiple deploy, watcher, and timer invocations needed locking.
- Rule ordering had to preserve Docker's own inter-network isolation while
  remaining ahead of terminal or bypass rules in `DOCKER-USER`.
- Verification needed to prove that every managed jump was reachable, not just
  present.
- A failed multi-command update could remove the last working policy before its
  replacement was installed.
- Discovering every bridge network broadened the policy from Besedy production
  to unrelated containers on the same host.

The result was still fail-open in important edge cases despite being much more
complex than the original control. That complexity was not justified for this
defense-in-depth measure.

## Current Security Posture

Container hardening such as a read-only filesystem, dropped capabilities,
`no-new-privileges`, restricted mounts, and the absence of a Docker socket
remains in place. Application-level outbound URL validation also remains in
place where implemented.

Those controls do not replace network egress isolation. If a container is
compromised, access to services reachable on the host's private networks must
currently be considered possible. Cloudflare Tunnel protects the inbound
origin path; it does not restrict outbound connections from containers.

## Removing an Earlier Host Installation

Deleting the repository assets does not remove files or live rules previously
installed on a host. During a maintenance window:

1. Disable and remove any `besedy-egress`, `besedy-egress-watch`, and
   `besedy-egress-refresh` systemd units or timers.
2. Remove `/usr/local/bin/iptables-egress.sh` if present.
3. Inspect `DOCKER-USER` for rules whose comments contain `besedy-egress` and
   remove them using the host's firewall tooling.
4. Remove a leftover `BESEDY-EGRESS` chain after all references to it are gone.
5. Run `systemctl daemon-reload` and verify the resulting Docker firewall and
   application connectivity.

Firewall cleanup is intentionally not automated here. Rule ownership and order
must be inspected on the target host before deletion.

## Requirements for a Future Design

Before restoring this control, define its threat model and scope explicitly.
A replacement should:

- identify only the production containers or networks that need isolation;
- use deterministic network identity where practical instead of discovering
  every Docker bridge;
- cover both IPv4 and IPv6 deliberately;
- preserve Docker's own network isolation and required service paths;
- update atomically or retain the last-known-good policy on failure;
- test real packet reachability, including rules that could bypass or shadow
  the policy; and
- make enforcement failure observable without reporting a false healthy state.

Prefer a small static design based on explicitly owned network configuration.
Do not restore the previous hardcoded-subnet script or the dynamic reconciler
without resolving these requirements.
