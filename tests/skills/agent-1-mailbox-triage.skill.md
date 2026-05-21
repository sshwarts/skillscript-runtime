# Skill: mailbox-triage
# Status: Approved
# Description: Run at session start to surface unprocessed mailbox items addressed to this agent, deduping against the seen-list and classifying each by urgency.
# Vars: AGENT, URGENCY_THRESHOLD=medium
# Requires: user-var:mailbox-seen-ids -> SEEN (fallback: [])
# Triggers: session: start
# Output: prompt-context: perry

fetch:
    > mode=fts query="addressed:$(AGENT)" limit=20 -> ITEMS

classify: needs: fetch
    foreach M in $(ITEMS):
        if $(M.id|trim) in $(SEEN):
            ! skipping $(M.id) — already in seen list
        elif $(M.id|trim) not in $(SEEN):
            ~ prompt="Classify urgency of this mailbox item as one of: low, medium, high, urgent. Item summary: $(M.summary). Item detail: $(M.detail). Respond with one word." -> VERDICT
            if $(VERDICT|trim) == "urgent":
                ! URGENT: $(M.id) — $(M.summary)
            elif $(VERDICT|trim) == "high":
                ! HIGH: $(M.id) — $(M.summary)
            else:
                ! $(VERDICT|trim): $(M.id) — $(M.summary)

default: classify
