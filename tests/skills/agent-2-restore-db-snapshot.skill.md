# Skill: restore-db-snapshot
# Status: Approved
# Description: Run when the user says "restore the dev DB from snapshot X" or "blow away local DB and reload"; pulls the snapshot from object storage, stops the dev container, restores, restarts; side-effect-only, emits progress lines but no return value
# Vars: SNAPSHOT_TAG, DB_CONTAINER=dev-postgres
# Output: none

resolve_snapshot:
    $ storage.list_snapshots prefix="$(SNAPSHOT_TAG)" -> CANDIDATES

pick_one:
    needs: resolve_snapshot
    ~ prompt="From this list of snapshot identifiers, pick the most recent one matching '$(SNAPSHOT_TAG)'. Return ONLY the identifier, nothing else.\n\n$(CANDIDATES|json)" model=qwen maxTokens=60 -> CHOSEN (fallback: "")
    if $(CHOSEN|trim):
        ! Picked snapshot: $(CHOSEN|trim)
    else:
        ! No snapshot matched '$(SNAPSHOT_TAG)' - aborting

stop:
    needs: pick_one
    @ docker stop $(DB_CONTAINER) -> STOPPED
    ! Stopped $(DB_CONTAINER)

restore:
    needs: stop
    @ unsafe aws s3 cp s3://dev-snapshots/$(CHOSEN|trim).sql.gz /tmp/restore-$$(date +%s).sql.gz
    @ unsafe gunzip -c /tmp/restore-*.sql.gz | docker exec -i $(DB_CONTAINER) psql -U postgres
    ! Restore stream completed

start:
    needs: restore
    @ docker start $(DB_CONTAINER) -> STARTED
    ! Started $(DB_CONTAINER); enumerating restored tables
    $ db.list_tables container=$(DB_CONTAINER) -> TABLES
    foreach T in $(TABLES):
        ! - restored table: $(T.summary)

default: start
