#!/usr/bin/env bash
set -euo pipefail

MONGO_URI="mongodb://mongodb:27017/admin?directConnection=true"

mongosh "$MONGO_URI" --quiet --eval '
    try {
        rs.initiate({
            _id: "rs0",
            members: [{ _id: 0, host: "mongodb:27017" }]
        });
    } catch (error) {
        if (error.codeName !== "AlreadyInitialized") throw error;
    }
'

for attempt in $(seq 1 60); do
    if mongosh "$MONGO_URI" --quiet --eval \
        'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then
        echo "MongoDB PRIMARY is ready."
        exit 0
    fi

    sleep 2
done

echo "MongoDB PRIMARY did not become ready." >&2
exit 1