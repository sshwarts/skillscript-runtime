# Skill: mailbox-triage
# Status: Approved
# Description: Sweep the addressed-mailbox at session start (or when the user asks "what's in my inbox"); route urgent items to immediate action, pending-approval items to a confirmation list, FYI items to a digest
# Vars: URGENT_TAGS=[alert, urgent, blocking]
# Output: text

scan:
    > mode=fts query="addressed mailbox" limit=30 -> MAIL

partition:
    needs: scan
    ! === Mailbox triage at $(NOW) ===
    ! 
    ! Urgent (needs action now):
    foreach M in $(MAIL):
        if $(M.thread_status) == "pending_approval":
            ! - APPROVE? [$(M.id|trim)] $(M.summary) (from $(M.agent_id))
        elif $(M.payload_type) == "thread":
            if $(M.thread_status) == "pending_response":
                ! - REPLY [$(M.id|trim)] $(M.summary)
    ! 
    ! Other items:
    foreach M in $(MAIL):
        if $(M.thread_status) != "pending_approval":
            if $(M.thread_status) != "pending_response":
                ! - FYI [$(M.id|trim)] $(M.summary) (conf=$(M.confidence))

default: partition
