# Hara architecture decisions

The collaboration-platform proposal is governed by the following accepted
decisions:

- [ADR-0001: Run collaboration as an independent NestJS service](./0001-independent-nestjs-collaboration-service.md)
- [ADR-0002: Use a Hara-native centralized protocol](./0002-hara-native-protocol-matrix-bridge.md)
- [ADR-0003: Keep the client open and the hosted collaboration service private](./0003-open-client-private-service.md)
- [ADR-0004: Make remote collaboration strictly optional](./0004-disabled-collaboration-zero-impact.md)
- [ADR-0005: Keep product repositories separate](./0005-polyrepo-and-collab-monorepo.md)

These records define the M0 implementation boundary. Later changes must add a
superseding ADR instead of silently changing the accepted architecture.
