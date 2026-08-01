# Skill capability review policy

Hara skills are knowledge assets with executable intent. Publishing their
Markdown is not enough to authorize tool or data access.

Each immutable `AssetVersion` now carries two separate lists:

- `requiredCapabilities`: exact capabilities declared by the skill author;
- `grantedCapabilities`: the reviewed subset approved by the administrator.

Capability names are exact lowercase identifiers such as `file.read` or
`channel.post`; wildcards are rejected. A reviewer cannot grant a capability
the version did not declare. Every new version starts with zero grants, so an
old approval cannot silently carry forward after the content changes.

Lifecycle edges are enforced server-side: only an `IN_REVIEW` version can be
approved or rejected, only a `PUBLISHED` asset can be promoted, and only a
`PUBLISHED` asset can be deprecated. Publication re-runs the injection and
secret guards before applying grants.

The device manifest and asset response return both lists. An execution host
must call the policy check before invoking a capability and then intersect the
result with organization policy and the active Collaboration audience floor.
Missing grants fail closed.

The current lifecycle remains:

```text
DRAFT -> IN_REVIEW -> PUBLISHED -> DEPRECATED
```

This change establishes the server contract and review data. It does not claim
that older CLI/Desktop versions enforce the new fields; the capability must
only be advertised after execution-host enforcement and UI review are shipped.
