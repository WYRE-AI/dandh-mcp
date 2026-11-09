// Never let a developer's real credentials or mode leak into the suite.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DANDH_') || ['AUTH_MODE', 'CONDUIT_S2S_SECRET', 'MCP_ALLOW_INSECURE_DEV'].includes(key)) delete process.env[key];
}
