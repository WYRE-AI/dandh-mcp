import { parseXmlUrlOverride } from './config.js';
import { loadConfirmSecret, loadOrderLimits } from './order-safety.js';

/**
 * Validates deployment-level settings that are not credentials (order caps, confirm secret,
 * XML endpoint override). Throws ConfigError so a bad value stops the server
 * at startup instead of surfacing mid-order.
 */
export function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  loadOrderLimits(env);
  loadConfirmSecret(env);
  parseXmlUrlOverride(env.DANDH_XML_URL);
}
