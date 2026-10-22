const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres throws on a malformed uuid, which would surface as a 500. Check before querying.
export const isUuid = (value: string): boolean => UUID_RE.test(value);
