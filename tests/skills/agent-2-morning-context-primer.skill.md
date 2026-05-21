# Skill: morning-context-primer
# Status: Approved
# Description: At session start, prepend a context block summarizing overnight activity (mailbox items, recent thread replies, pending approvals) so the agent enters its first turn pre-shaped instead of cold-querying
# Triggers: session: start
# Vars: HORIZON_HOURS=12
# Requires: user-var:primary-agent -> AGENT (fallback: assistant)
# Requires: system-var:morning-brief-delivered -> BRIEF_DELIVERED (fallback: false)
# Output: prompt-context: assistant

inbox:
    > mode=fts query="addressed mailbox pending" limit=10 mailbox_for=$(AGENT) -> ITEMS

threads:
    > mode=fts query="thread reply unresolved" limit=5 thread_status=pending_response -> THREADS

assemble:
    needs: inbox, threads
    ! === Morning context as of $(NOW) ===
    if $(BRIEF_DELIVERED):
        ! Note: morning brief already delivered earlier today; surfacing only items newer than the brief
    ! 
    ! Mailbox ($(HORIZON_HOURS)h horizon):
    foreach IT in $(ITEMS):
        ! - [$(IT.id|trim)] $(IT.summary) (from $(IT.agent_id))
    ! 
    ! Threads awaiting your response:
    foreach T in $(THREADS):
        ! - [$(T.id|trim)] $(T.summary) - status=$(T.thread_status)

default: assemble
