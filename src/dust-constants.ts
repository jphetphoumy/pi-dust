export const WORKOS_DOMAIN = "api.workos.com";
export const WORKOS_CLIENT_ID = "client_01JGCT55T7FVDG9XF74925R1KT";
export const REGION_CLAIM = "https://dust.tt/region";
export const DUST_US_URL = "https://dust.tt";
export const DUST_EU_URL = "https://eu.dust.tt";
export const DUST_CLI_VERSION = "0.4.4";
export const SESSION_EXPIRED_MESSAGE = "Dust session expired — run /logout then /login to re-authenticate.";
/** Distinguishes a lapsed MCP server registration (403/404) from a dead session (401). */
export const MCP_REGISTRATION_LOST_MESSAGE = "MCP server registration lost, re-registration required.";
/** Shown when the user interrupts a turn; not an error condition. */
export const CANCELLED_MESSAGE = "Cancelled by user.";
/** Returned to Dust for tool calls that arrive after the turn was cancelled. */
export const CANCELLED_TOOL_MESSAGE = "Tool execution cancelled by user.";

/** Name registered with Dust; tools are exposed as `<slugified name>__<tool>`. */
export const MCP_SERVER_NAME = "pi-dust-extension";
export const MCP_TOOL_PREFIX = "pi_dust_extension";

export const DUST_HEADERS = {
  "User-Agent": "Dust CLI",
  "X-Dust-CLI-Version": DUST_CLI_VERSION,
};

export const DUST_MCP_PROTOCOL_VERSION = "2025-06-18";
