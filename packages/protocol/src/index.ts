/**
 * ACNP protocol library entry point.
 * Real schemas, canonicalization and signing land on Day 3 (FEATURE-003).
 * Until then this only pins the protocol version string that every message
 * will carry, so services can import it from one place.
 */
export const PROTOCOL_VERSION = 'acnp/0.1' as const;
