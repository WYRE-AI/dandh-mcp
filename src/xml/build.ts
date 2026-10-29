/** Raised when a value cannot be placed safely in an XML request. Never contains secret values. */
export class XmlInputError extends Error {}

// XML 1.0 forbids most C0 controls; D&H also warns that stray special
// characters / BOMs cause "malformed or unparsable XML" failures. Reject
// rather than silently altering order data.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿﻿]/;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds `<NAME>escaped value</NAME>`. `label` names the field in errors (never the value). */
export function el(name: string, value: string | number, label = name): string {
  const text = String(value);
  if (INVALID_XML_CHARS.test(text)) {
    throw new XmlInputError(`${label} contains a control or byte-order-mark character that cannot be sent to D&H.`);
  }
  return `<${name}>${escapeXml(text)}</${name}>`;
}

export function wrap(name: string, ...children: (string | undefined)[]): string {
  return `<${name}>${children.filter((c): c is string => !!c).join('')}</${name}>`;
}

export function login(userCode: string, password: string): string {
  return wrap('LOGIN', el('USERID', userCode, 'XML user code'), el('PASSWORD', password, 'XML password'));
}

/** Form-encodes the document as the `xmlDoc` field (D&H "HTML form POST" submission method). */
export function formBody(xml: string): string {
  return new URLSearchParams({ xmlDoc: xml }).toString();
}
