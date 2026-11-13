export const DEFAULT_PORT = 3055;

// Reads the relay port from TALK_TO_FIGMA_PORT, falling back to 3055 when unset or empty.
export function getPort(value: string | undefined = process.env.TALK_TO_FIGMA_PORT): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TALK_TO_FIGMA_PORT "${value}": must be a whole number from 1 to 65535`);
  }
  return port;
}
