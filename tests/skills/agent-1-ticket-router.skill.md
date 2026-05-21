# Skill: ticket-router
# Status: Approved
# Description: Route an inbound support ticket to the correct triage queue based on classified topic and severity when a new ticket arrives.
# Vars: TICKET_ID, QUEUES=[billing, infra, product, security]
# Output: none

fetch:
    $ ticketstore.get_ticket id=$(TICKET_ID) -> TICKET

classify: needs: fetch
    ~ prompt="Classify this ticket into exactly one of: billing, infra, product, security, other. Subject: $(TICKET.subject). Body: $(TICKET.body). Respond with one word." -> TOPIC
    ~ prompt="Rate severity as one of: low, medium, high, critical. Body: $(TICKET.body). Respond with one word." model=qwen -> SEVERITY

route: needs: classify
    if $(TOPIC|trim) in $(QUEUES):
        $ ticketstore.assign id=$(TICKET_ID) queue=$(TOPIC|trim) severity=$(SEVERITY|trim) -> ACK
        ! routed $(TICKET_ID) to $(TOPIC|trim) (severity $(SEVERITY|trim))
    elif $(TOPIC|trim) not in $(QUEUES):
        $ ticketstore.assign id=$(TICKET_ID) queue=triage severity=$(SEVERITY|trim) -> ACK
        ! unrecognized topic $(TOPIC|trim) — sent $(TICKET_ID) to manual triage

default: route
