#!/usr/bin/env sh
set -eu
SOURCE=${ALFRED_DATA_DIR:-/var/lib/docker/volumes/alfred-node_alfred_data/_data/alfred.db}
DESTINATION=${ALFRED_BACKUP_DIR:-/opt/alfred-backups}
mkdir -p "$DESTINATION"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 "$SOURCE" ".backup '$DESTINATION/alfred-$stamp.sqlite3'"
gzip -9 "$DESTINATION/alfred-$stamp.sqlite3"
find "$DESTINATION" -name 'alfred-*.sqlite3.gz' -mtime +30 -delete
