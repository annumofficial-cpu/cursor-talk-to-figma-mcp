export const DEFAULT_PORT = 3055;
export const PORT_ENV_VAR = "TALK_TO_FIGMA_PORT";

// Port shared by the WebSocket relay and the MCP server. Unset or empty means DEFAULT_PORT.
export function resolvePort(value: string | undefined = process.env[PORT_ENV_VAR]): number {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return DEFAULT_PORT;
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 1 || port > 65535) {
    throw new Error(`${PORT_ENV_VAR} must be a whole number between 1 and 65535, got "${value}"`);
  }
  return port;
}
