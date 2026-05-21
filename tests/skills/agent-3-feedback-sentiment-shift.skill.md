# Skill: feedback-sentiment-shift
# Status: Approved
# Description: When the team requests a customer-sentiment read, pull recent feedback, classify per item, and surface if the negative ratio crossed a threshold versus baseline
# Vars: WINDOW=7d, THRESHOLD=0.25
# Output: prompt-context: product-lead

gather:
    > mode=semantic query="customer feedback last $(WINDOW)" limit=40 -> RECENT
    > mode=semantic query="customer feedback baseline" limit=40 -> BASELINE

classify:
    needs: gather
    $set NEG_RECENT = ""
    foreach M in $(RECENT):
        ~ prompt="Sentiment of feedback: $(M.summary). Answer positive, neutral, or negative only." -> S
        if $(S|trim) == "negative":
            ! $(M.id) negative
            $set NEG_RECENT = "x"

summary:
    needs: classify
    ~ prompt="Compare negative ratio in $(RECENT|json) vs baseline $(BASELINE|json). Threshold $(THRESHOLD). Reply in two lines: ratio_delta and recommended_action." -> ANALYSIS
    ! $(ANALYSIS)

default: summary
