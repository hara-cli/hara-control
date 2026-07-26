# Matrix research source snapshots

> Recorded: 2026-07-26
>
> Purpose: pin the exact third-party source used by Hara architecture research.

## Synapse

| Field | Value |
| --- | --- |
| Upstream | `https://github.com/element-hq/synapse.git` |
| Local path | `/Volumes/Jeff2TEXTEND1/projects/github/hara-chat-research/sources/synapse` |
| Commit | `97fb38eca66f74c4a761e1b1b394e4d19486e61b` |
| Commit time | `2026-07-24T16:39:04-05:00` |
| Commit subject | `Return M_USER_LIMIT_EXCEEDED error code for media upload limits from MSC4335 (#18876)` |
| Clone style | Shallow partial clone for bounded source study |
| Recorded size | Approximately 54 MiB |
| License | `AGPL-3.0-or-later OR LicenseRef-Element-Commercial` |

License evidence is present in the snapshot's `pyproject.toml`, `LICENSE-AGPL-3.0`, and
`LICENSE-COMMERCIAL`. Hara may study architecture and independently implement its own design; do not copy
Synapse implementation code into Hara without a separate license review.

## Initial source anchors

These anchors were verified in the pinned snapshot. They are starting points, not complete call-chain conclusions:

| Subsystem | Source anchor |
| --- | --- |
| Send room event REST entry | `synapse/rest/client/room.py::RoomSendEventRestServlet` |
| Event creation handler | `synapse/handlers/message.py::EventCreationHandler` |
| Create/send non-member event | `synapse/handlers/message.py::EventCreationHandler.create_and_send_nonmember_event` |
| `/sync` REST entry | `synapse/rest/client/sync.py::SyncRestServlet` |
| User sync handler | `synapse/handlers/sync.py::SyncHandler.wait_for_sync_for_user` |
| Membership update | `synapse/handlers/room_member.py::RoomMemberHandler.update_membership` |
| Locked membership update | `synapse/handlers/room_member.py::RoomMemberHandler.update_membership_locked` |
| Event authorisation | `synapse/event_auth.py` |

## Additional snapshots

| Repository | Branch / selection | Commit | Local path |
| --- | --- | --- | --- |
| Matrix Spec | `main` | `d0ba2aaef801e0134a4e5c6054a2c2f41bb55531` | `/Volumes/Jeff2TEXTEND1/projects/github/hara-chat-research/sources/matrix-spec` |
| Element Web | `develop` | `402c385d24395d453eed9c86d4418280baaec327` | `/Volumes/Jeff2TEXTEND1/projects/github/hara-chat-research/sources/element-web` |
| matrix-js-sdk | Element lockfile revision, detached | `08ea484e3b24ab82d0158e1c86aa67ca20d0862b` | `/Volumes/Jeff2TEXTEND1/projects/github/hara-chat-research/sources/matrix-js-sdk` |

All four repositories are shallow, clean source snapshots. Dependencies are not
installed. The research root is a separate Git repository whose `.gitignore`
excludes `sources/`.

See [`../../matrix-source-study-plan.md`](../../matrix-source-study-plan.md) for the staged process.

## Update rule

When a third-party snapshot changes:

1. add the new commit and date here;
2. preserve the previous SHA in Git history;
3. revalidate every study document that cites changed source;
4. label stale conclusions rather than silently carrying them forward.
