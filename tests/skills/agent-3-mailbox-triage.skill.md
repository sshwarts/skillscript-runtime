# Skill: mailbox-triage
# Status: Approved
# Description: When mailbox has more than a handful of items, classify each, pin urgent ones, and write a one-line triage summary back to the originating thread
# Vars: URGENCY_MODEL=qwen
# Output: text

pull:
    > mode=fts query="addressed:perry" limit=25 vault=private -> ITEMS
    > mode=fts query="recently triaged dedup" limit=50 -> SEEN_RAW

build_seen:
    needs: pull
    ~ prompt="Extract just the id field as a JSON array from $(SEEN_RAW|json). No other keys." -> SEEN

triage:
    needs: build_seen
    foreach M in $(ITEMS):
        if $(M.id|trim) in $(SEEN):
            ! $(M.id) already triaged
        elif $(M.thread_status) == "pending_response":
            ~ prompt="Urgency for this thread (urgent|normal|low): $(M.summary)" model=$(URGENCY_MODEL) -> LEVEL
            if $(LEVEL|trim) == "urgent":
                $ memorystore.update id=$(M.id) pinned=true -> ACK
                ! pinned $(M.id)
            else:
                ! left $(M.id) at $(LEVEL|trim)

default: triage
