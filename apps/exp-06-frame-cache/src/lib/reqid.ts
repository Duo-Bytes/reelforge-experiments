/**
 * The frame cache keys `pending`, `ramCache`, and `vramCache` by the REQUESTED
 * target microsecond. The decode worker, however, returns a frame whose
 * timestamp is the nearest sample PTS — which differs from the request. So a
 * decoded frame must be routed back to its request by `reqId`, which carries
 * the requested key, rather than by `frame.timestamp` (which would never match
 * and leave the request unresolved). These helpers make that key reversible.
 */
export const reqIdForTarget = (targetUs: number): string => `cache-${targetUs}`;

export function targetFromReqId(reqId: string): number {
  const dash = reqId.indexOf("-");
  return Number(reqId.slice(dash + 1));
}
