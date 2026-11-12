# Dump sidecar image (S1-BKP): only the PostgreSQL 17 client tools pg_dump and pg_restore, plus
# the busybox shell and the script. No server, no psql, no other client tool.
#
# Base: Alpine pinned by exact tag AND digest (no floating tag, no latest). It is the Alpine
# release the pinned postgres:17.11-alpine image is built on. The client comes from the Alpine
# package `postgresql17-client`; its major version must equal the server's (17), because pg_dump
# refuses a server newer than itself. An upgrade is deliberate: new digest, new package pin,
# pg_dump, upgrade, restore test (docs/runbooks/backup.md).
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

# tzdata makes TZ work (the nightly time is in the container's time zone). The client package
# ships more tools than the sidecar needs; everything except pg_dump and pg_restore is removed
# again, so what is installed is what the acceptance list names. The final line fails the build
# if the client is not 17.x.
RUN apk add --no-cache "postgresql17-client=~17.11" tzdata \
 && find /usr/bin /usr/sbin /usr/libexec/postgresql17 \( -type f -o -type l \) \
      \( -name 'pg_*' -o -name 'psql' -o -name 'createdb' -o -name 'createuser' -o -name 'dropdb' \
         -o -name 'dropuser' -o -name 'clusterdb' -o -name 'reindexdb' -o -name 'vacuumdb' -o -name 'pgbench' \) \
      ! -name pg_dump ! -name pg_restore -delete \
 && pg_dump --version | grep -q '^pg_dump (PostgreSQL) 17\.' \
 && pg_restore --version | grep -q '^pg_restore (PostgreSQL) 17\.'

# /dumps is the host directory (bind mount), /state the named volume with the last_ok file. A
# fresh named volume copies the owner and mode of its image directory, and the container runs
# as whatever A2A_UID is (the owner of the secret file), so /state is world-writable. The
# volume is private to the compose project; the server mounts it read-only.
RUN mkdir /dumps /state && chmod 0777 /state

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
