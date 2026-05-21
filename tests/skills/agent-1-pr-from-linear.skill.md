# Skill: pr-from-linear
# Status: Approved
# Description: Open a draft PR scaffolded from a Linear issue when the user types /pr-from-linear with an issue id.
# Vars: ISSUE_ID, BASE_BRANCH=main
# Output: text

fetch:
    $ linear.get_issue id=$(ISSUE_ID) -> ISSUE

plan: needs: fetch
    ~ prompt="Propose a branch name and PR title for this Linear issue. Title prefix [$(ISSUE_ID)]. Issue: $(ISSUE.title) — $(ISSUE.description). Reply as: BRANCH=<slug>\\nTITLE=<text>" -> PLAN
    ! Proposed plan:
    ! $(PLAN)

confirm: needs: plan
    ?? "Open the PR with this plan?" -> APPROVED
else:
    ! user declined; aborting PR creation
    $set APPROVED = "no"

open: needs: confirm
    @ git checkout -b "$(ISSUE_ID|trim)-scaffold" -> CHECKOUT
    @ git push --set-upstream origin "$(ISSUE_ID|trim)-scaffold" -> PUSH
    $ github.create_pr base=$(BASE_BRANCH) title="[$(ISSUE_ID|trim)] $(ISSUE.title)" draft=true -> PR
    ! draft PR opened: $(PR.url)

default: open
