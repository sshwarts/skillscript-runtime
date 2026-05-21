# Skill: coverage-gate
# Status: Approved
# Description: When a PR is pushed and coverage is reported, refuse merge below threshold unless the human explicitly overrides
# Vars: PR_NUMBER, MIN_COVERAGE=80
# Requires: system-var:coverage-strict-mode -> STRICT (fallback: true)
# Output: text

probe:
    $ codecov.fetch pr=$(PR_NUMBER) -> REPORT
else:
    $set REPORT = ""
    ! could not fetch coverage — defaulting to safe refuse

decide:
    needs: probe
    if $(REPORT):
        ~ prompt="Given coverage report $(REPORT|json) and threshold $(MIN_COVERAGE), answer pass or fail only." -> VERDICT
    else:
        $set VERDICT = "fail"

resolve:
    needs: decide
    if $(VERDICT|trim) == "pass":
        ! coverage passes — clear to merge
    elif $(STRICT) == "true":
        !! Coverage below $(MIN_COVERAGE) on PR $(PR_NUMBER) — refusing.
    else:
        ?? "Coverage below $(MIN_COVERAGE) on PR $(PR_NUMBER). Override and allow merge?" -> APPROVED
        if $(APPROVED):
            $ github.add_label pr=$(PR_NUMBER) label=coverage-override -> ACK
            ! merge unblocked under override

default: resolve
