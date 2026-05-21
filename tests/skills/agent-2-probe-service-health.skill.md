# Skill: probe-service-health
# Status: Approved
# Description: Probe a named service endpoint and emit a degradation signal when health checks fail or return non-OK status; run before deploys, hourly health sweeps, or any time a user reports flakiness
# Vars: SERVICE_URL, EXPECTED_STATUS=ok
# Requires: user-var:probe-timeout-seconds -> TIMEOUT (fallback: 10)
# OnError: probe-service-health-degraded
# Output: text

probe:
    @ curl -s --max-time $(TIMEOUT) $(SERVICE_URL) -> RAW
    ~ prompt="Extract the value of the 'status' field from this JSON. Return ONLY the value, no quotes, no whitespace, no commentary:\n\n$(RAW)" model=qwen maxTokens=20 -> STATUS (fallback: "unknown")
else:
    $set STATUS = "unreachable"
    ! probe failed; treating service as unreachable

decide:
    needs: probe
    if $(STATUS|trim) == "$(EXPECTED_STATUS)":
        ! Service $(SERVICE_URL) healthy (status=$(STATUS|trim))
        $ memorystore.write summary="health-check OK $(SERVICE_URL)" detail="status=$(STATUS|trim)" knowledge_type=common vault=private
    elif $(STATUS|trim) == "unreachable":
        ! Service $(SERVICE_URL) unreachable - escalating
        $ memorystore.write summary="DEGRADED unreachable $(SERVICE_URL)" detail="probe timed out after $(TIMEOUT)s" knowledge_type=hard_won vault=private domain_tags=["alert","health"]
    else:
        ! Service $(SERVICE_URL) returned unexpected status: $(STATUS|trim)
        $ memorystore.write summary="DEGRADED status=$(STATUS|trim) $(SERVICE_URL)" detail="expected $(EXPECTED_STATUS), got $(STATUS|trim)" knowledge_type=hard_won vault=private domain_tags=["alert","health"]

default: decide
