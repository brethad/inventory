# Loopback local preview without login

`LOCAL_NO_AUTH` is off unless it is set to `true`. Password login, SSO, and the
read-only demo stay the normal way to sign in. This mode does not replace them
and does not change existing organizations.

## What true does

On startup the app reconciles one writable organization and one user:

| | |
| --- | --- |
| Organization id | `10ca1000-0000-4000-8000-000000000001` |
| Organization slug | `local-preview` (kept if that row was renamed; never taken from another organization) |
| User id | `10ca1000-0000-4000-8000-000000000002` |
| User email | `local-preview@inventory.invalid` |

The user has no known password. A direct request to `127.0.0.1`, `localhost`, or
`::1` is served as that admin without a session cookie and without an API
token. Inventory create, update, and delete, photos, locations, and room pages
use the normal permission checks. The preview user is not a deployment
superadmin and is not a member of any other organization.

The seed refuses to continue, and does not delete or reassign rows, when:

- another organization already uses the slug `local-preview`
- another user already uses the preview email
- the preview user already belongs to a different organization
- another user already belongs to the preview organization

System roles on that one organization are updated to the current built-in
permission set. Inventory items, photos, and type labels already stored there
are left in place. Turning the flag off leaves the rows in the database and
returns the app to normal login.

## Request rules

Anonymous access is applied only when all of these are true:

- `LOCAL_NO_AUTH=true`
- the request `Host` is loopback (`127.0.0.1:3001` is still loopback when the
  published port is not the container's port 3000)
- `X-Forwarded-Host`, when present, is loopback
- `X-Forwarded-For`, when present, is loopback or a private address. Next.js
  fills this with the TCP peer. Docker's publish proxy uses a private bridge
  address such as `172.18.0.1` even though the browser opened `127.0.0.1`. A
  public address is refused
- `Origin`, when present, is loopback
- `Sec-Fetch-Site` is not `cross-site`
- the request has no usable bearer token
- the browser has no authenticated session

A real session is used as itself. An invalid bearer token does not fall through
to the preview user. The preview user cannot be exchanged for a native app
token, and the preview identity cannot create API tokens. `AUTH_URL` must
itself be an `http` or `https` loopback URL or the process exits before listen.

The `Host` header is chosen by the client. Binding the published port to
`127.0.0.1` is what keeps other machines out. A process listening on `0.0.0.0`
can be reached by anyone who can route to it, and that client can send
`Host: 127.0.0.1`.

## Enable it on a Docker host

Use a private env file:

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 48   # AUTH_SECRET
```

```env
LOCAL_NO_AUTH=true
AUTH_URL=http://127.0.0.1:3000
AUTH_SECRET=<48-byte hex>
POSTGRES_PASSWORD=<32-byte hex>
AUTH_PASSWORD_ENABLED=true
DEMO_ACCESS_ENABLED=false
```

Publish with the existing loopback override, not an open port:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Open `http://127.0.0.1:3000`. The first screen is the local preview inventory,
not the login form. A separate password account can still exist in the
database; it is not used until `LOCAL_NO_AUTH` is set back to `false`.

`deploy/local-no-auth/docker-compose.yml` is the same mode for a preloaded
image. It does not build source. Postgres has no published port. The app
publishes `127.0.0.1` only.

```bash
docker load -i inventory-local-no-auth.tar
docker compose --env-file local-no-auth.env -f deploy/local-no-auth/docker-compose.yml up -d
```

## Assistant Linux host and the Windows PC

These are different machines.

The assistant Linux host already runs Docker and can load the image archive
built in the development VM. That install does not need a source checkout or a
build on the assistant host. Keep it on `127.0.0.1`. It is not reachable from
the Windows browser unless that Linux port is deliberately published off the
machine, which this mode forbids.

The inspected Windows 10 Pro 22H2 PC has no Docker, no Podman, WSL turned off,
and no Linux distro. This repository does not ship a Windows executable,
service, or portable Node folder. A Linux image and Linux `node_modules` will
not run there. Quark, Chrome, and Edge can open the app only after some
runtime on that PC is listening on loopback. Installing Docker Desktop or
turning on WSL is a separate approval; it was not done here. Do not clone or
build the source on that PC, and do not put the no-auth port behind a public
tunnel.

## Limits

- AI features still need the usual API keys. This mode does not add any.
- Room capture from the iOS app is unchanged and still needs a normal account.
  The preview user cannot mint the mobile token.
- Label-printer and QZ signing routes that require an API-token administrator
  session still require that session. Inventory, stock, media, map, and room
  pages do not.
- `LOCAL_NO_AUTH=true` together with a non-loopback `AUTH_URL` fails startup.
- There is no supported way to expose this mode safely beyond the host that
  runs it.
