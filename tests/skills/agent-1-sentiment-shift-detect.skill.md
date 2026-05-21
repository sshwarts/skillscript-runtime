# Skill: sentiment-shift-detect
# Status: Draft
# Description: Compare the last 24h of customer feedback against the previous 24h and surface a shift when the rolling sentiment moves more than one bucket.
# Vars: PRODUCT, BUCKETS=[negative, mixed, neutral, positive]
# Requires: user-var:last-sentiment-bucket -> PRIOR (fallback: neutral)
# Triggers: cron: 0 */6 * * *
# Output: prompt-context: perry

recent:
    > mode=fts query="feedback product:$(PRODUCT) created_after:$(EVENT.fired_at_unix)" limit=50 -> RECENT

classify: needs: recent
    ~ prompt="Aggregate the sentiment of these feedback items into exactly one bucket: negative, mixed, neutral, positive. Items: $(RECENT|json). Respond with one word." -> CURRENT (fallback: "neutral")
else:
    ! classifier failed; assuming neutral
    $set CURRENT = "neutral"

compare: needs: classify
    if $(CURRENT|trim) == $(PRIOR|trim):
        ! sentiment stable at $(CURRENT|trim) for $(PRODUCT)
    elif $(CURRENT|trim) in $(BUCKETS):
        if $(PRIOR|trim):
            ! SHIFT: $(PRODUCT) moved from $(PRIOR|trim) to $(CURRENT|trim) over the last window
            $ memorystore.write summary="sentiment shift on $(PRODUCT)" detail="from $(PRIOR|trim) to $(CURRENT|trim) at $(NOW)" scope=private -> ACK
        else:
            ! first sentiment reading for $(PRODUCT): $(CURRENT|trim)

default: compare
