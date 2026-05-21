# Skill: wait-for-ci
# Status: Approved
# Description: After pushing a branch, poll CI status for the named PR until pass/fail/timeout; emit a single status line plus structured record so future skills can read whether the branch is green
# Vars: PR_NUMBER, REPO_SLUG, POLL_TIMEOUT=600
# OnError: wait-for-ci-degraded
# Output: text

snapshot:
    @ gh pr checks $(PR_NUMBER) --repo $(REPO_SLUG) --json name,state,conclusion -> CHECKS_RAW

prior_run:
    > mode=fts query="ci status $(REPO_SLUG) pr=$(PR_NUMBER)" limit=1 -> PRIOR (fallback: [])

verdict:
    needs: snapshot, prior_run
    ~ prompt="Below is the JSON output of `gh pr checks` for PR #$(PR_NUMBER) on $(REPO_SLUG). Decide overall status. Reply with EXACTLY one of: 'pass', 'fail', 'pending'. No other text.\n\n$(CHECKS_RAW)" model=qwen maxTokens=10 -> STATE

record:
    needs: verdict
    if $(STATE|trim) == "pass":
        ! CI passing for PR #$(PR_NUMBER) on $(REPO_SLUG)
        $ memorystore.write summary="ci pass $(REPO_SLUG)#$(PR_NUMBER)" detail=$(CHECKS_RAW|json) knowledge_type=common vault=private domain_tags=["ci","pass"]
    elif $(STATE|trim) == "fail":
        ! CI FAILING for PR #$(PR_NUMBER) on $(REPO_SLUG); inspect failed checks
        $ memorystore.write summary="ci fail $(REPO_SLUG)#$(PR_NUMBER)" detail=$(CHECKS_RAW|json) knowledge_type=hard_won vault=private domain_tags=["ci","fail","alert"]
    else:
        ! CI still pending for PR #$(PR_NUMBER); re-run this skill or wait

default: record
