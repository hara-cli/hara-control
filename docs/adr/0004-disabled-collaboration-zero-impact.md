# ADR-0004: Make remote collaboration strictly optional

- Status: Accepted
- Date: 2026-07-26

## Context

Many Hara users need only local sessions. Adding remote groups must not make
local startup, model selection, projects, approvals or search depend on a
cloud account or network availability.

## Decision

Remote collaboration is disabled by default until the user explicitly signs
in or accepts an invitation. In the disabled state:

- no DNS, HTTP, WebSocket or collaboration telemetry is sent;
- no `~/.hara/collab` directory or collaboration database is created;
- no collaboration worker, timer or listening port starts;
- existing local session databases are not migrated;
- model, profile, gateway, approval and local-search behavior does not change;
- renderer code never receives a refresh token;
- local and remote search/storage remain separate domains.

CLI/Desktop negotiate the public capability `collaboration.remote.v1`.
Initial protocol methods are:

```text
collab.status
collab.login
collab.realms.list
collab.bootstrap
collab.sync
collab.message.send
collab.read.update
```

An older peer that does not advertise the capability is treated as
collaboration-disabled, not as an error.

## Required release gates

1. Default startup makes no collaboration network request.
2. Default startup creates no collaboration file or database.
3. New Desktop + old CLI and old Desktop + new CLI continue to work.
4. Enabled collaboration going offline does not affect local Agent sessions.
5. Switching company cannot mutate an existing session's pinned profile,
   realm or model route.
6. Logout/expiration clears only collaboration credentials and cache.

## Consequences

- The optional service can be added without changing the reliability contract
  of local Hara.
- Capability negotiation and disabled-state tests are required before any
  group UI is enabled.
- Background sync cannot be started merely because the client package is
  installed.
