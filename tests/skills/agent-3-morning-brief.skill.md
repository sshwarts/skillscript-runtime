# Skill: morning-brief
# Status: Approved
# Description: Run at 7am local to assemble a morning brief from mailbox + overnight scans + calendar — fires session-start as well so Perry boots warm
# Vars: BRIEF_DEPTH=standard
# Requires: user-var:location -> LOCATION (fallback: Asheville, NC)
# Requires: user-var:assistant-name -> ASSISTANT (fallback: perry)
# Triggers: cron: 0 7 * * *
# Triggers: session: start
# OnError: morning-brief-degraded
# Output: prompt-context: perry

inbox:
    > mode=rerank query="unprocessed mailbox urgent" limit=10 vault=private -> MAIL
    > mode=fts query="overnight scan digest $(EVENT.fired_at_unix)" limit=5 -> SCANS (fallback: [])

weather:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW
    ~ prompt="One-line weather summary from $(RAW|trim). No preamble." -> CONDITIONS

agenda:
    $ calendar.list_today user=$(ASSISTANT) -> EVENTS (fallback: [])

assemble:
    needs: inbox, weather, agenda
    ~ prompt="Compose Perry's morning brief. Mail: $(MAIL|json). Scans: $(SCANS|json). Weather: $(CONDITIONS). Agenda: $(EVENTS|json). Depth: $(BRIEF_DEPTH). Lead with the most decision-relevant item." -> BRIEF
    ! $(BRIEF)

default: assemble
