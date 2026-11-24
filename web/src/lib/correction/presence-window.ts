/**
 * The timing of correction presence, shared by the page that reports it and
 * the server that reads it.
 *
 * The page says where its person is every `PRESENCE_HEARTBEAT_SECONDS` while
 * its tab is visible; a person not heard from for `PRESENCE_WINDOW_SECONDS`
 * counts as gone, so a closed tab or a sleeping phone clears itself.
 */
export const PRESENCE_HEARTBEAT_SECONDS = 30;
/** Three heartbeats: one lost request does not make a person flicker away. */
export const PRESENCE_WINDOW_SECONDS = 90;
