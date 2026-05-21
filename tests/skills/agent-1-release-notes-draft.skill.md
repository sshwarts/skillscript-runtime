# Skill: release-notes-draft
# Status: Approved
# Description: Draft release notes from merged-PR commit messages when the release coordinator needs a first-pass changelog.
# Vars: FROM_TAG, TO_TAG=HEAD, AUDIENCE=customer
# Output: text

commits:
    @ git log --pretty=format:%s --no-merges $(FROM_TAG)..$(TO_TAG|trim) -> LOG

prs:
    $ github.list_merged_prs from_tag=$(FROM_TAG) to_tag=$(TO_TAG|trim) -> PRS

categorize: needs: commits, prs
    foreach PR in $(PRS):
        ~ prompt="Classify PR #$(PR.id) as one of: feature, fix, refactor, docs, chore. Title: $(PR.title). Respond with one word." -> KIND
        ! $(KIND|trim): #$(PR.id) — $(PR.title)

draft: needs: categorize
    ~ prompt="Write release notes for audience=$(AUDIENCE). Use the per-PR emissions above plus raw commit log for color. PRs: $(PRS|json). Commits: $(LOG|json). Group by category." model=qwen maxTokens=1500 -> NOTES
    ! $(NOTES)

default: draft
