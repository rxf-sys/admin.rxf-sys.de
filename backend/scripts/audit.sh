#!/usr/bin/env bash
# Curated audit script for the rxf-sys admin dashboard.
#
# Emits exactly one JSON object on the last stdout line, of shape:
#   {"summary":{"ok":N,"warn":N,"err":N,"skipped":N},
#    "findings":[
#      {"id":"...","status":"ok|warn|err|skipped","title":"...","detail":"...",
#       "category":"updates|hardening|storage|backup|network|...",  // optional
#       "fix":"sudo apt upgrade -y"}                                // optional
#    ]}
#
# ``category`` and ``fix`` are optional — the frontend derives a category
# from the leading dot-segment of ``id`` when ``category`` is absent, and
# only renders the FIX line when a snippet is provided.
#
# Designed to run BOTH locally inside the backend container and on the
# Proxmox host via SSH (`ssh ... bash -s < audit.sh`). Each check degrades
# to status=skipped when its tool or path is not available, so the same
# script produces meaningful output in either environment.

set -uo pipefail

OK="ok"; WARN="warn"; ERR="err"; SKIP="skipped"

count_ok=0; count_warn=0; count_err=0; count_skipped=0
findings_json=""

esc() {
    # JSON-escape stdin.
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    printf '%s' "$s"
}

add_finding() {
    # add_finding id status title detail [category] [fix]
    # The category and fix arguments are optional. Empty strings are skipped
    # so the resulting JSON object stays minimal when the upstream check
    # doesn't have a remediation hint or category to attach.
    local id="$1" status="$2" title="$3" detail="$4"
    local category="${5:-}" fix="${6:-}"
    local entry
    entry=$(printf '{"id":"%s","status":"%s","title":"%s","detail":"%s"' \
        "$(esc "$id")" "$(esc "$status")" "$(esc "$title")" "$(esc "$detail")")
    if [[ -n "$category" ]]; then
        entry="${entry},\"category\":\"$(esc "$category")\""
    fi
    if [[ -n "$fix" ]]; then
        entry="${entry},\"fix\":\"$(esc "$fix")\""
    fi
    entry="${entry}}"
    case "$status" in
        "$OK")   count_ok=$((count_ok + 1)) ;;
        "$WARN") count_warn=$((count_warn + 1)) ;;
        "$ERR")  count_err=$((count_err + 1)) ;;
        "$SKIP") count_skipped=$((count_skipped + 1)) ;;
    esac
    if [[ -z "$findings_json" ]]; then
        findings_json="$entry"
    else
        findings_json="$findings_json,$entry"
    fi
}

has() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 1) System info (always present)
# ---------------------------------------------------------------------------
host_name=$(hostname 2>/dev/null || echo unknown)
kernel=$(uname -r 2>/dev/null || echo unknown)
uptime_h=$(uptime -p 2>/dev/null || uptime 2>/dev/null || echo unknown)
add_finding "system.info" "$OK" "System" "${host_name} · kernel ${kernel} · ${uptime_h}"

# ---------------------------------------------------------------------------
# 2) SSH server config (PermitRootLogin, PasswordAuthentication)
# ---------------------------------------------------------------------------
SSHD="/etc/ssh/sshd_config"
if [[ -r "$SSHD" ]]; then
    permit_root=$(awk '/^[[:space:]]*PermitRootLogin/ {print $2; exit}' "$SSHD")
    permit_root="${permit_root:-default}"
    case "$permit_root" in
        no|prohibit-password)
            add_finding "ssh.permit_root_login" "$OK" "SSH PermitRootLogin" "Root-Login deaktiviert (${permit_root})"
            ;;
        *)
            add_finding "ssh.permit_root_login" "$WARN" "SSH PermitRootLogin" "Root-Login erlaubt (${permit_root}) — Sicherheitsrisiko"
            ;;
    esac

    pw_auth=$(awk '/^[[:space:]]*PasswordAuthentication/ {print $2; exit}' "$SSHD")
    pw_auth="${pw_auth:-default}"
    case "$pw_auth" in
        no)
            add_finding "ssh.password_auth" "$OK" "SSH PasswordAuthentication" "Passwort-Auth deaktiviert"
            ;;
        *)
            add_finding "ssh.password_auth" "$WARN" "SSH PasswordAuthentication" "Passwort-Auth aktiv (${pw_auth})"
            ;;
    esac
else
    add_finding "ssh.config" "$SKIP" "SSH-Config" "sshd_config nicht lesbar — Audit aus Container ausgeführt, SSH-Setup zum Host nötig (AUDIT_SSH_HOST)"
fi

# ---------------------------------------------------------------------------
# 3) Firewall (nftables preferred, iptables fallback)
# ---------------------------------------------------------------------------
fw_handled=0
if has nft; then
    nft_out=$(nft list ruleset 2>/dev/null || true)
    if [[ -n "$nft_out" ]]; then
        rule_count=$(printf '%s' "$nft_out" | grep -cE '^[[:space:]]*(accept|drop|reject|jump|return)' || true)
        if [[ "$rule_count" -gt 0 ]]; then
            add_finding "firewall.nft" "$OK" "Firewall (nftables)" "${rule_count} aktive Regeln"
            fw_handled=1
        fi
    fi
fi
if [[ "$fw_handled" -eq 0 ]] && has iptables; then
    if rules=$(iptables -S 2>/dev/null); then
        rule_count=$(printf '%s' "$rules" | grep -cv '^-P' || true)
        if [[ "$rule_count" -gt 0 ]]; then
            add_finding "firewall.iptables" "$OK" "Firewall (iptables)" "${rule_count} aktive Regeln"
        else
            add_finding "firewall.iptables" "$WARN" "Firewall (iptables)" "Keine Regeln gesetzt — alles offen"
        fi
        fw_handled=1
    fi
fi
if [[ "$fw_handled" -eq 0 ]]; then
    add_finding "firewall" "$SKIP" "Firewall" "Weder nft noch iptables verfügbar — Container-Audit sieht nur Container-Netz, AUDIT_SSH_HOST setzen für Host-Firewall"
fi

# ---------------------------------------------------------------------------
# 4) Listening TCP ports
# ---------------------------------------------------------------------------
if has ss; then
    ports=$(ss -H -tln 2>/dev/null | awk '{print $4}' | awk -F: '{print $NF}' | sort -nu | tr '\n' ',' | sed 's/,$//')
    if [[ -z "$ports" ]]; then
        add_finding "ports.listening" "$OK" "Lauschende TCP-Ports" "Keine offenen Ports"
    else
        port_count=$(printf '%s' "$ports" | tr ',' '\n' | grep -c .)
        add_finding "ports.listening" "$OK" "Lauschende TCP-Ports" "${port_count} Ports: ${ports}"
    fi
else
    add_finding "ports.listening" "$SKIP" "Lauschende TCP-Ports" "'ss' nicht im PATH — sollte im Backend-Container vorhanden sein, ggf. Image neu bauen"
fi

# ---------------------------------------------------------------------------
# 5) Package updates
# ---------------------------------------------------------------------------
if has apt; then
    upgradable=$(apt list --upgradable 2>/dev/null | tail -n +2 | grep -c . || true)
    if [[ "$upgradable" -eq 0 ]]; then
        add_finding "packages.updates" "$OK" "Paket-Updates" "Alles aktuell"
    elif [[ "$upgradable" -lt 10 ]]; then
        add_finding "packages.updates" "$WARN" "Paket-Updates" "${upgradable} Pakete aktualisierbar"
    else
        add_finding "packages.updates" "$ERR" "Paket-Updates" "${upgradable} Pakete aktualisierbar — System veraltet"
    fi
else
    add_finding "packages.updates" "$SKIP" "Paket-Updates" "'apt' nicht verfügbar"
fi

# ---------------------------------------------------------------------------
# 6) Disk SMART
# ---------------------------------------------------------------------------
if has smartctl; then
    if has lsblk; then
        disks=$(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk" {print "/dev/"$1}')
    else
        disks=""
    fi
    if [[ -z "$disks" ]]; then
        add_finding "disks.smart" "$SKIP" "Disk-SMART" "Keine Block-Devices gefunden"
    else
        bad=""; good=0; unknown=0
        for d in $disks; do
            health=$(smartctl -H "$d" 2>/dev/null | awk '/SMART overall-health|SMART Health Status/ {print $NF}' | head -1)
            case "$health" in
                PASSED|OK) good=$((good + 1)) ;;
                FAILED|FAIL) bad="${bad}${d} " ;;
                *) unknown=$((unknown + 1)) ;;
            esac
        done
        if [[ -n "$bad" ]]; then
            add_finding "disks.smart" "$ERR" "Disk-SMART" "FAIL bei: ${bad}"
        elif [[ "$good" -gt 0 ]]; then
            add_finding "disks.smart" "$OK" "Disk-SMART" "${good} Disks PASSED (${unknown} ohne SMART-Daten)"
        else
            add_finding "disks.smart" "$SKIP" "Disk-SMART" "Keine SMART-Daten lesbar (Rechte?)"
        fi
    fi
else
    add_finding "disks.smart" "$SKIP" "Disk-SMART" "smartctl braucht echten Disk-Zugriff — entweder SSH zum Proxmox-Host (AUDIT_SSH_HOST) oder /dev-Bind-Mount"
fi

# ---------------------------------------------------------------------------
# 7) Failed systemd services
# ---------------------------------------------------------------------------
if has systemctl; then
    failed_lines=$(systemctl --failed --no-legend 2>/dev/null || true)
    failed_count=$(printf '%s' "$failed_lines" | grep -c . || true)
    if [[ "$failed_count" -eq 0 ]]; then
        add_finding "systemd.failed" "$OK" "Fehlgeschlagene Dienste" "Keine"
    else
        names=$(printf '%s' "$failed_lines" | awk '{print $2}' | head -5 | tr '\n' ' ')
        add_finding "systemd.failed" "$ERR" "Fehlgeschlagene Dienste" "${failed_count} Dienste: ${names}"
    fi
else
    add_finding "systemd.failed" "$SKIP" "Fehlgeschlagene Dienste" "systemctl im Container nicht aussagekräftig — Host-Audit via SSH setzen (AUDIT_SSH_HOST)"
fi

# ---------------------------------------------------------------------------
# 8) Storage: /data mount + write access + free space
# ---------------------------------------------------------------------------
DATA_DIR="${RXF_DATA_DIR:-/data}"
if [[ -d "$DATA_DIR" ]]; then
    if touch "${DATA_DIR}/.audit_probe" 2>/dev/null; then
        rm -f "${DATA_DIR}/.audit_probe"
        if has df; then
            usage=$(df -P "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
            avail=$(df -Ph "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
            if [[ -n "$usage" ]]; then
                if [[ "$usage" -gt 90 ]]; then
                    add_finding "storage.data" "$ERR" "Storage /data" "${usage}% belegt, nur ${avail} frei — kritisch" \
                        "storage" "Größeres Volume mounten oder alte Backups prunen"
                elif [[ "$usage" -gt 75 ]]; then
                    add_finding "storage.data" "$WARN" "Storage /data" "${usage}% belegt, ${avail} frei" "storage"
                else
                    add_finding "storage.data" "$OK" "Storage /data" "${usage}% belegt, ${avail} frei" "storage"
                fi
            else
                add_finding "storage.data" "$OK" "Storage /data" "beschreibbar (df-Output unparsbar)" "storage"
            fi
        else
            add_finding "storage.data" "$OK" "Storage /data" "beschreibbar (df nicht verfügbar)" "storage"
        fi
    else
        add_finding "storage.data" "$ERR" "Storage /data" "Verzeichnis nicht beschreibbar — Volume-Permissions prüfen" \
            "storage" "chown -R \$(id -u):\$(id -g) /data im Container"
    fi
else
    add_finding "storage.data" "$WARN" "Storage /data" "${DATA_DIR} existiert nicht — Volume-Mount prüfen" "storage"
fi

# ---------------------------------------------------------------------------
# 9) Memory usage
# ---------------------------------------------------------------------------
if [[ -r /proc/meminfo ]]; then
    mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
    if [[ -n "$mem_total" && -n "$mem_avail" && "$mem_total" -gt 0 ]]; then
        used_pct=$(( (mem_total - mem_avail) * 100 / mem_total ))
        used_mb=$(( (mem_total - mem_avail) / 1024 ))
        total_mb=$(( mem_total / 1024 ))
        if [[ "$used_pct" -gt 90 ]]; then
            add_finding "memory.usage" "$ERR" "Speicher" "${used_pct}% belegt (${used_mb} MB / ${total_mb} MB)" "system"
        elif [[ "$used_pct" -gt 80 ]]; then
            add_finding "memory.usage" "$WARN" "Speicher" "${used_pct}% belegt (${used_mb} MB / ${total_mb} MB)" "system"
        else
            add_finding "memory.usage" "$OK" "Speicher" "${used_pct}% belegt (${used_mb} MB / ${total_mb} MB)" "system"
        fi
    else
        add_finding "memory.usage" "$SKIP" "Speicher" "MemTotal/MemAvailable nicht lesbar" "system"
    fi
else
    add_finding "memory.usage" "$SKIP" "Speicher" "/proc/meminfo nicht lesbar" "system"
fi

# ---------------------------------------------------------------------------
# 10) Load average vs CPU count
# ---------------------------------------------------------------------------
if [[ -r /proc/loadavg ]]; then
    load1=$(awk '{print $1}' /proc/loadavg)
    cpus=$(nproc 2>/dev/null || awk '/^processor/ {n++} END {print n+0}' /proc/cpuinfo)
    [[ "$cpus" -lt 1 ]] && cpus=1
    # bash can't do float math — compare as scaled int (×100).
    load_scaled=$(awk -v l="$load1" 'BEGIN{printf "%d", l*100}')
    threshold_warn=$((cpus * 100))    # load == cpu count = 100%
    threshold_err=$((cpus * 200))     # 2× cpu count = severe overload
    if [[ "$load_scaled" -gt "$threshold_err" ]]; then
        add_finding "system.load" "$ERR" "Last (1 min)" "${load1} auf ${cpus} Kerne — überlastet" "system"
    elif [[ "$load_scaled" -gt "$threshold_warn" ]]; then
        add_finding "system.load" "$WARN" "Last (1 min)" "${load1} auf ${cpus} Kerne — hoch" "system"
    else
        add_finding "system.load" "$OK" "Last (1 min)" "${load1} auf ${cpus} Kerne" "system"
    fi
else
    add_finding "system.load" "$SKIP" "Last (1 min)" "/proc/loadavg nicht lesbar" "system"
fi

# ---------------------------------------------------------------------------
# 11) DNS lookup of the zone — confirms outbound DNS works + zone resolves
# ---------------------------------------------------------------------------
DNS_TARGET="${CF_ZONE_NAME:-rxf-sys.de}"
if has dig; then
    a_record=$(dig +short +time=3 +tries=1 "$DNS_TARGET" A 2>/dev/null | head -1)
    if [[ -n "$a_record" ]]; then
        add_finding "dns.zone" "$OK" "DNS-Auflösung (${DNS_TARGET})" "A → ${a_record}" "network"
    else
        add_finding "dns.zone" "$WARN" "DNS-Auflösung (${DNS_TARGET})" "Kein A-Record auflösbar" "network" \
            "Outbound-DNS prüfen (resolv.conf, Firewall)"
    fi
elif has getent; then
    if a_record=$(getent hosts "$DNS_TARGET" 2>/dev/null | awk '{print $1; exit}'); then
        add_finding "dns.zone" "$OK" "DNS-Auflösung (${DNS_TARGET})" "→ ${a_record}" "network"
    else
        add_finding "dns.zone" "$WARN" "DNS-Auflösung (${DNS_TARGET})" "Lookup fehlgeschlagen" "network"
    fi
else
    add_finding "dns.zone" "$SKIP" "DNS-Auflösung" "weder dig noch getent verfügbar" "network"
fi

# ---------------------------------------------------------------------------
# 12) Container/host uptime sanity — flag very-fresh reboots so the operator
#     sees that the host bounced recently when interpreting the report
# ---------------------------------------------------------------------------
if [[ -r /proc/uptime ]]; then
    uptime_s=$(awk '{printf "%d", $1}' /proc/uptime)
    if [[ "$uptime_s" -lt 600 ]]; then
        add_finding "system.uptime" "$WARN" "Uptime" "weniger als 10 min — kürzlich neugestartet" "system"
    elif [[ "$uptime_s" -lt 86400 ]]; then
        add_finding "system.uptime" "$OK" "Uptime" "$(( uptime_s / 3600 ))h $(( (uptime_s % 3600) / 60 ))min" "system"
    else
        add_finding "system.uptime" "$OK" "Uptime" "$(( uptime_s / 86400 ))d $(( (uptime_s % 86400) / 3600 ))h" "system"
    fi
fi

# ---------------------------------------------------------------------------
# Output (single JSON line as the contract requires)
# ---------------------------------------------------------------------------
printf '{"summary":{"ok":%d,"warn":%d,"err":%d,"skipped":%d},"findings":[%s]}\n' \
    "$count_ok" "$count_warn" "$count_err" "$count_skipped" "$findings_json"
