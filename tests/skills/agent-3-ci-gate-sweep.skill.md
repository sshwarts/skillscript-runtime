# Skill: ci-gate-sweep
# Status: Approved
# Description: When asked to check CI on the current branch and decide whether to re-run flaky failures, fetch checks, classify each failed job, and emit a re-run plan
# Vars: BRANCH, FLAKY_JOBS=[unit-tests-macos, e2e-smoke], COVERAGE_MIN=80
# Requires: user-var:github-repo -> REPO (fallback: owner/repo)
# Output: text

fetch:
    $ github.list_checks repo=$(REPO) ref=$(BRANCH) -> CHECKS
    > mode=fts query="ci flakiness $(BRANCH)" limit=3 -> PRIOR (fallback: [])

classify:
    needs: fetch
    $set RERUN_PLAN = ""
    foreach JOB in $(CHECKS):
        if $(JOB.conclusion) == "success":
            ! $(JOB.name) green
        elif $(JOB.name) in $(FLAKY_JOBS):
            ! $(JOB.name) failed but is known flaky — queueing rerun
            $ github.rerun_job repo=$(REPO) job_id=$(JOB.id) -> ACK
        elif $(JOB.conclusion) != "success":
            ~ prompt="One sentence on whether this CI failure is transient or real, given log tail: $(JOB.log_tail). Answer transient or real." -> VERDICT
            if $(VERDICT|trim) == "transient":
                $ github.rerun_job repo=$(REPO) job_id=$(JOB.id) -> ACK
            else:
                ! $(JOB.name) failed (real) — leaving for human

report:
    needs: classify
    ~ prompt="Summarize the rerun decisions for branch $(BRANCH) given the check set $(CHECKS|json). Two-line summary." -> SUMMARY
    ! $(SUMMARY)

default: report
