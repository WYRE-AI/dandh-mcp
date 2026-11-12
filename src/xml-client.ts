/**
 * The only path to D&H's dhXML dispatcher. The URL is fixed per country (no
 * override), the request is a documented read-only query (price,
 * availability, item inquiry, order status) form-POSTed as `xmlDoc`, and the
 * shared contract applies: redirects refused, body bounded, no retries.
 */
import { maxUpstreamBytes } from './config.js';
import { dandhFetch, readBoundedText, requestIdOf, USER_AGENT, withRequestId } from './fetch-util.js';
import { redactText } from './redact.js';
import { formBody } from './xml/build.js';
import { child, parseXml, textOf, XmlParseError, type XmlNode } from './xml/parse.js';
import { DandhApiError, type XmlCountry, type XmlCredentials } from './types.js';

export const XML_URLS: Record<XmlCountry, string> = {
  // Documented in D&H's US XML guide (DH.IS.WEB.XML.1, Dec 2024); answered 411 to an empty POST on 2026-11-09.
  us: 'https://www.dandh.com/dhXML/xmlDispatch',
  // The submission URL in D&H's Canada XML guide (DH.IS.WEB.XML.2, Feb 2024).
  ca: 'https://www.dandh.ca/dhXML/xmlDispatch',
};

const XML_SERVICE = 'the D&H XML service';

const HTML_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;
const AUTH_HINT_RE = /\b(log\s?in|user\s?(id|code|name)|password|credential|authenticat|not authori[sz]ed|access denied)\b/i;

function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (HTML_RE.test(body)) return true;
  return /text\/html/i.test(contentType ?? '') && !/<XMLRESPONSE[\s>]/.test(body);
}

/**
 * POSTs one XML document and returns the parsed <XMLRESPONSE> root. Anything
 * but a success response becomes a DandhApiError with the password removed.
 */
export async function xmlPost(xml: XmlCredentials, requestXml: string): Promise<XmlNode> {
  const url = new URL(XML_URLS[xml.country]);
  const res = await dandhFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml, text/xml', 'user-agent': USER_AGENT },
      body: formBody(requestXml),
    },
    XML_SERVICE,
  );
  const requestId = requestIdOf(res);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new DandhApiError(withRequestId(`D&H XML service error (HTTP ${res.status}).`, requestId), res.status, requestId);
  }

  const text = await readBoundedText(res, maxUpstreamBytes(), XML_SERVICE);
  if (looksLikeHtml(text, res.headers.get('content-type'))) {
    throw new DandhApiError(
      'D&H returned a web page instead of XML. This usually means the sign-in was rejected (check the XML UserCode/Password and that D&H Automation Services XML access is enabled for the user) or D&H is down for maintenance.',
      res.status,
      requestId,
    );
  }

  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch (err) {
    throw new DandhApiError(`D&H returned an unreadable XML response (${err instanceof XmlParseError ? err.message : 'unparsable'}).`, res.status, requestId);
  }
  if (root.name !== 'XMLRESPONSE') throw new DandhApiError(`D&H returned an unexpected XML document (<${root.name}>).`, res.status, requestId);

  const status = textOf(root, 'STATUS')?.toLowerCase();
  const failed = status === 'failure';
  if (failed || (status !== 'success' && !child(root, 'ITEM') && !child(root, 'ORDERSTATUS'))) {
    const rawMessage = textOf(root, 'MESSAGE');
    if (rawMessage === undefined && !failed) throw new DandhApiError('D&H returned an XML response without a success status.', res.status, requestId);
    const message = redactText(rawMessage ?? 'no message', [xml.password, xml.userCode]).slice(0, 500);
    const prefix = AUTH_HINT_RE.test(message) ? 'D&H XML request failed (possible sign-in problem)' : 'D&H XML request failed';
    throw new DandhApiError(withRequestId(`${prefix}: ${message}`, requestId), res.status, requestId);
  }
  return root;
}
