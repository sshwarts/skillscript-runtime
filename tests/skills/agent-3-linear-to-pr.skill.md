# Skill: linear-to-pr
# Status: Approved
# Description: When the user references a Linear ticket and asks to start work, create a branch, pull ticket context, and open a draft PR with the ticket body auto-filled
# Vars: TICKET_ID, BASE_BRANCH=main
# Output: text

ticket:
    $ linear.get_issue id=$(TICKET_ID) -> ISSUE
else:
    $set ISSUE = ""
    ! could not fetch Linear ticket $(TICKET_ID) — aborting
    $set ABORT = "1"

branch:
    needs: ticket
    if $(ABORT):
        ! skipping branch creation
    else:
        @ git checkout -b feature/$(ISSUE.identifier) $(BASE_BRANCH) -> CHK
        ! $(CHK|trim)

pr:
    needs: branch
    if $(ABORT):
        ! skipping PR creation
    else:
        @ git push -u origin feature/$(ISSUE.identifier) -> PUSH
        ~ prompt="Write a one-paragraph PR description from this Linear ticket: title=$(ISSUE.title), body=$(ISSUE.description). End with 'Closes $(ISSUE.identifier)'." -> BODY
        $ github.create_pr title="$(ISSUE.title)" body="$(BODY)" head=feature/$(ISSUE.identifier) base=$(BASE_BRANCH) draft=true -> CREATED
        ! draft PR opened: $(CREATED.url)

default: pr
