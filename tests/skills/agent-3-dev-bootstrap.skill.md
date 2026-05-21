# Skill: dev-bootstrap
# Status: Approved
# Description: When starting work on this project after a pull, restore the database snapshot, run pending migrations, and start the dev server — only re-bootstrap fresh if schema hash changed
# Vars: SNAPSHOT=nightly, FORCE=false
# Requires: system-var:last-schema-hash -> LAST_HASH (fallback: none)
# Output: text

hash:
    @ git rev-parse HEAD:db/schema.sql -> CURRENT_HASH

decide:
    needs: hash
    if $(FORCE) == "true":
        $set DO_RESTORE = "1"
    elif $(CURRENT_HASH|trim) != $(LAST_HASH):
        $set DO_RESTORE = "1"
    else:
        $set DO_RESTORE = ""

restore:
    needs: decide
    if $(DO_RESTORE):
        ! schema changed (or forced) — restoring snapshot $(SNAPSHOT)
        @ unsafe pg_restore -d devdb /snapshots/$(SNAPSHOT).dump 2>&1 | tail -5 -> RESTORE_LOG
        ! $(RESTORE_LOG|trim)
        $ statestore.set key=last-schema-hash value=$(CURRENT_HASH|trim) -> ACK
    else:
        ! schema unchanged — skipping restore

migrate:
    needs: restore
    @ pnpm run migrate:up -> MIGR
    ! $(MIGR|trim)

serve:
    needs: migrate
    ! dev environment ready — start the dev server in a separate terminal: pnpm dev

default: serve
