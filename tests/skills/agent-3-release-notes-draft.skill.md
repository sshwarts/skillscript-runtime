# Skill: release-notes-draft
# Status: Approved
# Description: When cutting a release, read the git log between tags and draft user-facing release notes
# Vars: PREV_TAG, NEW_TAG
# Output: text

draft:
    @ git log --pretty=format:%s $(PREV_TAG)..$(NEW_TAG) -> LOG
    @ git shortlog -sn $(PREV_TAG)..$(NEW_TAG) -> AUTHORS
    ~ prompt="Draft release notes from commit list:\n$(LOG|trim)\n\nContributors:\n$(AUTHORS|trim)\n\nGroup into Features / Fixes / Other. Skip merge commits. No marketing." model=qwen maxTokens=1500 -> NOTES
    ! $(NOTES)

default: draft
