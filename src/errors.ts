/**
 * A bounded, actionable failure reported to the client.
 *
 * The message is the whole payload: never a stacktrace, never a host path,
 * never a value the caller did not already supply.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError'
}

/** A configuration failure raised before the server begins serving. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}
