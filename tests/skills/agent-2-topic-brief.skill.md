# Skill: topic-brief
# Status: Approved
# Description: Generate a 5-bullet brief on TOPIC when a user asks for background on a project, person, or concept they reference without context
# Vars: TOPIC, MAX_SOURCES=5
# Output: text

gather:
    > mode=rerank query="$(TOPIC)" limit=$(MAX_SOURCES) -> SOURCES

format_sources:
    needs: gather
    $set BULLETS = ""
    foreach M in $(SOURCES):
        ! - $(M.summary) [id=$(M.id|trim), conf=$(M.confidence)]

synthesize:
    needs: format_sources
    ~ prompt="You are briefing a colleague on '$(TOPIC)'. Below are the top retrieved sources, each with id, summary, and confidence. Produce 5 bullets capturing the load-bearing facts. Cite source ids inline as [id=...].\n\nSources:\n$(format_sources.output)" model=qwen maxTokens=600 -> BRIEF
    ! $(BRIEF|trim)

default: synthesize
