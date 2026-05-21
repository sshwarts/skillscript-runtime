# Skill: error-signature-scan
# Status: Approved
# Description: Scan recent logs for known error signatures every five minutes and emit a degradation signal when a fresh match appears.
# Vars: SERVICE, WINDOW_MINUTES=5
# Requires: system-var:last-scan-fingerprint -> LAST_FP (fallback: none)
# Triggers: cron: */5 * * * *
# Output: none

signatures:
    > mode=fts query="error-signature service:$(SERVICE)" limit=20 -> PATTERNS

scan: needs: signatures
    @ unsafe journalctl -u $(SERVICE) --since "$(WINDOW_MINUTES) minutes ago" | grep -E "ERROR|FATAL" | tail -n 200 > /tmp/scan-$$(date +%s).log
    @ unsafe sha256sum /tmp/scan-$$(date +%s).log -> FP

decide: needs: scan
    if $(FP|trim) == $(LAST_FP|trim):
        ! no change since last scan
    elif $(FP|trim) != $(LAST_FP|trim):
        foreach P in $(PATTERNS):
            ~ prompt="Does this log slice contain pattern '$(P.summary)'? Reply yes or no. Log: $(scan.output)" -> HIT
            if $(HIT|trim) == "yes":
                $ memorystore.write summary="signature hit on $(SERVICE)" detail="pattern=$(P.id) at $(NOW)" scope=private -> ACK
                ! signature hit: $(P.id) on $(SERVICE)

default: decide
