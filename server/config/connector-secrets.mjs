const connectorEnvironmentNames = Object.freeze({
  sif: "SIF_MCP_SECRET",
  sorftime: "SORFTIME_MCP_KEY",
  sellerSprite: "SELLERSPRITE_SECRET_KEY",
});

/**
 * @param {keyof typeof connectorEnvironmentNames} connector
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {string | null}
 */
export function readServerConnectorSecret(connector, env = process.env) {
  const environmentName = connectorEnvironmentNames[connector];
  if (!environmentName) {
    throw new TypeError("Unknown connector secret");
  }

  const value = env[environmentName];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * @param {Readonly<Record<string, string | undefined>>} [env]
 */
export function getServerConnectorSecretState(env = process.env) {
  return Object.freeze({
    sif: readServerConnectorSecret("sif", env) !== null,
    sorftime: readServerConnectorSecret("sorftime", env) !== null,
    sellerSprite: readServerConnectorSecret("sellerSprite", env) !== null,
  });
}
