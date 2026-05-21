# Skill: standup-prep
# Status: Approved
# Description: Each weekday morning (and at first session of the day), assemble a standup-ready summary: yesterday's commits, today's open PRs awaiting your review, and any threads where you owe a reply
# Triggers: cron: 0 8 * * 1-5
# Triggers: session: start
# Vars: GIT_AUTHOR=me, REVIEW_LOOKBACK_DAYS=1
# Output: slack: my-standup-notes
# Output: prompt-context: assistant

yesterday_commits:
    @ git log --author=$(GIT_AUTHOR|shell) --since="1 day ago" --oneline -> COMMITS
else:
    $set COMMITS = "(git log unavailable)"

open_reviews:
    @ gh pr list --search "review-requested:@me" --json number,title,repository -> REVIEWS
else:
    $set REVIEWS = "[]"

owed_replies:
    > mode=fts query="thread pending-response addressed to me" limit=5 thread_status=pending_response -> REPLIES

compose:
    needs: yesterday_commits, open_reviews, owed_replies
    ! === Standup prep $(NOW) ===
    ! 
    ! Yesterday I committed:
    ! $(COMMITS)
    ! 
    ! PRs awaiting my review:
    ! $(REVIEWS)
    ! 
    ! Threads where I owe a reply:
    foreach R in $(REPLIES):
        if $(R.summary):
            ! - [$(R.id|trim)] $(R.summary) (from $(R.agent_id))

default: compose
