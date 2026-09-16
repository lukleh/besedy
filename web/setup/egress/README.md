# Egress Setup

These files are host setup assets, not scheduled maintenance scripts.

- `iptables-egress.sh` installs Docker `DOCKER-USER` rules that block container
  access to RFC1918 LAN ranges while still allowing inter-container traffic and
  outbound internet access. Container subnets are discovered from Docker on
  every run — they are never hardcoded, because compose re-allocates them
  whenever a stack is recreated.
- `besedy-egress.service` is a `systemd` unit that reapplies those rules after
  Docker starts and after every Docker restart (`PartOf=docker.service`).

Use them during host deployment or security hardening:

```bash
sudo cp web/setup/egress/iptables-egress.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/iptables-egress.sh
sudo cp web/setup/egress/besedy-egress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now besedy-egress.service
```

Re-run `systemctl enable` after updating the unit: the `WantedBy=docker.service`
link is what starts the unit when Docker starts.

Check enforcement rather than assuming it — the rules fail open, so a stale or
missing rule looks exactly like a working one until you look at the counters:

```bash
sudo /usr/local/bin/iptables-egress.sh --verify    # non-zero exit on drift
sudo /usr/local/bin/iptables-egress.sh --dry-run   # show the plan, change nothing
sudo iptables -L BESEDY-EGRESS -n -v --line-numbers
```

The ongoing scheduled checks remain under `web/scripts/`:

- `audit-check.sh`
- `security-update-check.sh`
- `weekly-report.sh`
- `backup-health-check.sh`
- `host-backup-health-check.sh`
