# Skill: ci-status-check
# Status: Approved
# Description: Read CI status for a given branch when an agent needs to know whether a downstream deploy is safe to start.
# Vars: BRANCH, REPO=primary-app
# Output: text

probe:
    @ gh run list --branch $(BRANCH) --repo $(REPO) --limit 1 --json status,conclusion -> RAW
    ~ prompt="Extract the single-word conclusion from this gh output. Respond with one of: success, failure, in_progress, unknown. Output: $(RAW)" -> VERDICT (fallback: "unknown")
else:
    ! CI probe failed; defaulting to unknown
    $set VERDICT = "unknown"

report: needs: probe
    if $(VERDICT|trim) == "success":
        ! CI green on $(BRANCH) — safe to proceed
    elif $(VERDICT|trim) == "failure":
        ! CI RED on $(BRANCH) — block downstream
    elif $(VERDICT|trim) == "in_progress":
        ! CI still running on $(BRANCH) — recheck shortly
    else:
        ! CI status unknown on $(BRANCH) — manual check required

default: report
