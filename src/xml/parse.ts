/**
 * Minimal, safe XML parser for D&H responses.
 *
 * Deliberately small: elements, attributes, text, CDATA, comments, XML
 * declarations and the five predefined + numeric entities. DOCTYPE/ENTITY
 * declarations are rejected outright, so there is no entity expansion, no
 * external resource loading, and no DTD processing.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Trimmed, entity-decoded text content (direct text only). */
  text: string;
}

export class XmlParseError extends Error {}

const MAX_INPUT_CHARS = 5_000_000;
const MAX_DEPTH = 64;

const TOKEN_RE =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
    }
  });
}

export function parseXml(input: string): XmlNode {
  if (input.length > MAX_INPUT_CHARS) throw new XmlParseError('XML document is too large.');
  const src = input.replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new XmlParseError('DOCTYPE/ENTITY declarations are not supported.');

  const stack: XmlNode[] = [];
  const texts: string[][] = [];
  let root: XmlNode | undefined;

  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new XmlParseError(`Malformed XML near offset ${pos}.`);
    pos = TOKEN_RE.lastIndex;
    const [, cdata, closeName, openName, attrSrc, selfClose, text] = m;

    if (cdata !== undefined) {
      if (stack.length) texts[texts.length - 1].push(cdata);
    } else if (text !== undefined) {
      if (stack.length) texts[texts.length - 1].push(decodeEntities(text));
      else if (text.trim()) throw new XmlParseError('Text outside the root element.');
    } else if (closeName !== undefined) {
      const node = stack.pop();
      const parts = texts.pop();
      if (!node || node.name !== closeName) throw new XmlParseError(`Mismatched closing tag </${closeName}>.`);
      node.text = (parts ?? []).join('').trim();
    } else if (openName !== undefined) {
      const node: XmlNode = { name: openName, attrs: {}, children: [], text: '' };
      for (const a of (attrSrc ?? '').matchAll(ATTR_RE)) {
        node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new XmlParseError('Multiple root elements.');
      else root = node;
      if (!selfClose) {
        if (stack.length >= MAX_DEPTH) throw new XmlParseError('XML is nested too deeply.');
        stack.push(node);
        texts.push([]);
      }
    }
    // comments / processing instructions: skipped
  }
  if (stack.length) throw new XmlParseError(`Unclosed element <${stack[stack.length - 1].name}>.`);
  if (!root) throw new XmlParseError('No root element.');
  return root;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function childrenOf(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Text of the first child with this name, or undefined if absent or empty. */
export function textOf(node: XmlNode | undefined, name: string): string | undefined {
  const t = child(node, name)?.text;
  return t ? t : undefined;
}
