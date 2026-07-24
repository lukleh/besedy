# Egress Setup

These files are host setup assets, not scheduled maintenance scripts.

- `iptables-egress.sh` installs Docker `DOCKER-USER` rules that block container
  access to RFC1918 LAN ranges while still allowing inter-container traffic and
  outbound internet access.
- `besedy-egress.service` is a `systemd` unit that reapplies those rules after
  Docker starts.

Use them during host deployment or security hardening:

```bash
sudo cp web/setup/egress/iptables-egress.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/iptables-egress.sh
sudo cp web/setup/egress/besedy-egress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now besedy-egress.service
```

The ongoing scheduled checks remain under `web/scripts/`:

- `audit-check.sh`
- `security-update-check.sh`
- `weekly-report.sh`
- `backup-health-check.sh`
- `host-backup-health-check.sh`
