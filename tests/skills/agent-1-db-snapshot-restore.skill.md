# Skill: db-snapshot-restore
# Status: Approved
# Description: Restore a local dev database from a named snapshot when a developer needs to reset state to a known baseline before reproducing a bug.
# Vars: SNAPSHOT_NAME, DB_NAME=devdb
# Output: none

locate:
    > mode=fts query="snapshot name:$(SNAPSHOT_NAME)" limit=1 -> META (fallback: "missing")

verify: needs: locate
    if $(META.id):
        ! found snapshot $(META.id) — $(META.summary)
    else:
        ! snapshot $(SNAPSHOT_NAME) not found in catalog

confirm: needs: verify
    ?? "Restore $(DB_NAME) from snapshot $(SNAPSHOT_NAME|trim)? This DROPS the current database." -> GO
else:
    ! restore aborted by user
    $set GO = "no"

restore: needs: confirm
    @ pg_dump --version -> _
    @ dropdb --if-exists $(DB_NAME) -> DROPPED
    @ createdb $(DB_NAME) -> CREATED
    $ snapshotstore.restore name=$(SNAPSHOT_NAME) target=$(DB_NAME) -> ACK
    ! restored $(DB_NAME) from $(SNAPSHOT_NAME|trim) at $(NOW)

default: restore
