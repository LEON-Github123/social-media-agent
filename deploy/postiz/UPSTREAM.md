# Official Postiz deployment inputs

Verified on **2026-09-24**. This project maintains the content worker and a
Compose override. It does not fork or rebuild the Postiz application.

| Component                       | Pinned input                                                              | Source                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official Compose tree           | `dd4969e5e694cd009619a0d53cff14c21104580b`                                | [Commit](https://github.com/gitroomhq/postiz-docker-compose/commit/dd4969e5e694cd009619a0d53cff14c21104580b)                                                                                                                                                                         |
| Postiz application              | `v2.24.0`                                                                 | [Release](https://github.com/gitroomhq/postiz-app/releases/tag/v2.24.0)                                                                                                                                                                                                              |
| Postiz multi-architecture image | `sha256:01b24a4fc1055f6833122c99614805bea702fdc0ee30c9b5d09330b521fa1efa` | [Official GHCR package](https://github.com/gitroomhq/postiz-app/pkgs/container/postiz-app)                                                                                                                                                                                           |
| Temporal server                 | `temporalio/auto-setup:1.28.1`                                            | Official Compose above                                                                                                                                                                                                                                                               |
| Temporal admin tools            | `temporalio/admin-tools:1.28.1-tctl-1.18.4-cli-1.4.1`                     | Official Compose above; optional `admin` profile                                                                                                                                                                                                                                     |
| Temporal UI                     | `temporalio/ui:2.34.0`                                                    | Official Compose above; optional `debug` profile                                                                                                                                                                                                                                     |
| Elasticsearch                   | `elasticsearch:7.17.27`                                                   | Official Compose above                                                                                                                                                                                                                                                               |
| Application PostgreSQL          | `postgres:17-alpine`                                                      | Official Compose above                                                                                                                                                                                                                                                               |
| Temporal PostgreSQL             | `postgres:16`                                                             | Official Compose above                                                                                                                                                                                                                                                               |
| Redis                           | `redis:7.2`                                                               | Official Compose above                                                                                                                                                                                                                                                               |
| Content worker runtime          | `node:24.21.0-bookworm-slim`, Yarn `1.22.22`                              | [Official image tag registration](https://github.com/docker-library/official-images/blob/master/library/node), [Dockerfile](https://github.com/nodejs/docker-node/blob/93a7bafc324a85ac1ee461604cff87cffacb6d7a/24/bookworm-slim/Dockerfile), and this repository's `packageManager` |

The Postiz image is pinned by immutable manifest digest as well as release tag.
Infrastructure images retain the official version tags; those tags can receive
patch rebuilds and are **not** immutable digest pins. The application release and
current official Compose tree have been checked together against their published
configuration; this is not a claim that this environment ran the entire stack.

`bootstrap.sh` fetches the **whole tree** at the pinned commit into ignored
`upstream/`, including its LICENSE and both files:

- `dynamicconfig/development-sql.yaml`
- `dynamicconfig/development-cass.yaml`

The complete official dynamicconfig directory stays mounted read-only. The
override points the running service at our `dynamicconfig/production-sql.yaml`,
which retains the 255-character ID limit and omits the upstream development-only
`system.forceSearchAttributesCacheRefreshOnRead` setting. Both files and their
purpose are visible in the [official directory](https://github.com/gitroomhq/postiz-docker-compose/tree/dd4969e5e694cd009619a0d53cff14c21104580b/dynamicconfig).

## Deliberate differences from the upstream example

- Replace the mutable Postiz `latest` image with the recorded release and digest.
- Supply independently generated database, Redis and JWT secrets through runtime
  environment variables; fail on missing required secrets.
- Bind the public application port to host loopback for a host reverse proxy.
  Remove Temporal's host gRPC port and keep data services inside Docker networks.
- Scope container and network names to the Compose project.
- Keep all official application/Temporal storage volumes. Add the worker's
  separate `content-data` volume and a read-only local content configuration mount.
- Keep Temporal UI and admin tools optional. The upstream Spotlight development
  service is in a separate, unsupported `upstream-spotlight` profile.
- Default the official application's registration setting to a single initial
  signup. The [v2.24.0 auth service](https://github.com/gitroomhq/postiz-app/blob/v2.24.0/apps/backend/src/services/auth/auth.service.ts)
  allows the first organization when `DISABLE_REGISTRATION=true`.

The [v2.24.0 Nginx configuration](https://github.com/gitroomhq/postiz-app/blob/v2.24.0/var/docker/nginx.conf)
listens on **5000** and proxies `/api/` to backend port 3000. Consequently the
worker uses `http://postiz:5000/api/public/v1`, while users visit the configured
public HTTPS domain. Postiz owns platform authentication, schedules and publish
retries after a submission has been accepted.

## Upgrade procedure

Update the official Compose commit, application image tag and digest in one
reviewed change after reading the target release's migration notes. Re-run
`docker compose config --quiet` through our wrapper, verify the mounted paths,
and exercise API authentication, draft creation, synchronization and a separately
authorized scheduled test against a staging instance. Preserve the old checkout
and take database/volume backups before an upgrade. Do not delete volumes or
overwrite an altered upstream checkout as an upgrade shortcut.

The fetched upstream tree retains its AGPL-3.0 license. It remains an official
deployment dependency, not a second application repository to maintain.
