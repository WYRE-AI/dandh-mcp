import { DandhApiError, DandhAuthError, retryConfig } from './rest-client.js';
import { formBody } from './xml/build.js';
import { child, parseXml, textOf, XmlParseError, type XmlNode } from './xml/parse.js';
import { redact } from './utils/redact.js';
import type { XmlCountry, XmlCredentials } from './types.js';

export const XML_URLS: Record<XmlCountry, string> = {
  us: 'https://www.dandh.com/dhXML/xmlDispatch',
  // UNCONFIRMED: the Canadian XML guide (DH-IS-WEB-XML_CA.pdf) was not
  // available; this assumes the same path on dandh.ca.
  ca: 'https://www.dandh.ca/dhXML/xmlDispatch',
};

/** Optional deployment override of the XML endpoint (must be https). */
function xmlUrl(country: XmlCountry): string {
  const override = process.env.DANDH_XML_URL?.trim();
  if (override) {
    if (!/^https:\/\//i.test(override)) throw new DandhApiError('DANDH_XML_URL must be an https:// URL.');
    return override;
  }
  return XML_URLS[country];
}

const HTML_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

export function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (HTML_RE.test(body)) return true;
  // A web page that wraps its markup differently, but is clearly not an XMLRESPONSE.
  return /text\/html/i.test(contentType ?? '') && !/<XMLRESPONSE[\s>]/.test(body);
}

const AUTH_HINT_RE = /\b(log\s?in|user\s?(id|code|name)|password|credential|authenticat|not authori[sz]ed|access denied)\b/i;

export interface XmlCallOptions {
  /** Read-only requests are retried on 429/5xx/network errors; order entry never is. */
  idempotent: boolean;
  /** Extra exact values to scrub from error text (e.g. a drop-ship password). */
  secrets?: string[];
  /** Phrase appended when the outcome of a failed/unclear submission matters. */
  onUnknownOutcome?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POSTs one XML document (form field `xmlDoc`) to the D&H dispatcher and
 * returns the parsed <XMLRESPONSE> root with STATUS == success. Anything else
 * becomes a DandhApiError / DandhAuthError whose message is already redacted.
 */
export async function xmlRequest(
  xml: XmlCredentials,
  requestXml: string,
  opts: XmlCallOptions,
): Promise<XmlNode> {
  const url = xmlUrl(xml.country);
  const secrets = [xml.password, ...(opts.secrets ?? [])];
  const unknown = opts.onUnknownOutcome ? ` ${opts.onUnknownOutcome}` : '';
  let attempt = 0;

  for (;;) {
    let res: Response | undefined;
    let netErr: Error | undefined;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml, text/xml' },
        body: formBody(requestXml),
        signal: AbortSignal.timeout(opts.idempotent ? 20_000 : 30_000),
      });
    } catch (err) {
      netErr = err as Error;
    }

    if (netErr) {
      if (opts.idempotent && attempt < retryConfig.maxRetries) {
        await sleep(Math.min(retryConfig.baseDelayMs * 2 ** attempt++, retryConfig.maxDelayMs));
        continue;
      }
      throw new DandhApiError(`Could not reach D&H XML service: ${redact(netErr.message, secrets)}.${unknown}`);
    }

    const response = res!;
    if (!response.ok) {
      if (opts.idempotent && (response.status === 429 || response.status >= 500) && attempt < retryConfig.maxRetries) {
        await sleep(Math.min(retryConfig.baseDelayMs * 2 ** attempt++, retryConfig.maxDelayMs));
        continue;
      }
      throw new DandhApiError(`D&H XML service error (HTTP ${response.status}).${unknown}`, response.status);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new DandhApiError(`Could not read the D&H XML response.${unknown}`);
    }

    if (looksLikeHtml(text, response.headers.get('content-type'))) {
      throw new DandhAuthError(
        'D&H returned a web page instead of XML. This usually means the sign-in was rejected (check the XML UserCode/Password and that D&H Automation Services XML access is enabled for the user) or D&H is down for maintenance.' +
          unknown,
      );
    }

    let root: XmlNode;
    try {
      root = parseXml(text);
    } catch (err) {
      const why = err instanceof XmlParseError ? err.message : 'unparsable';
      throw new DandhApiError(`D&H returned an unreadable XML response (${why}).${unknown}`);
    }
    if (root.name !== 'XMLRESPONSE') {
      throw new DandhApiError(`D&H returned an unexpected XML document (<${root.name}>).${unknown}`);
    }

    const status = textOf(root, 'STATUS')?.toLowerCase();
    if (status === 'failure') {
      const message = redact(textOf(root, 'MESSAGE') ?? 'no message', secrets).slice(0, 500);
      const prefix = AUTH_HINT_RE.test(message) ? 'D&H XML request failed (possible sign-in problem)' : 'D&H XML request failed';
      throw new DandhApiError(`${prefix}: ${message}`);
    }
    if (status !== 'success' && !child(root, 'ORDERNUM') && !child(root, 'ITEM') && !child(root, 'ORDERSTATUS')) {
      throw new DandhApiError(`D&H returned an XML response without a success status.${unknown}`);
    }
    return root;
  }
}
