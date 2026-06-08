/**
 * Sanitize gateway model ids for Claude Desktop discovery.
 * Desktop filters vendor names and some family shorthand in ids (not display_name).
 */
const VENDOR_REPLACEMENTS: Array<[RegExp, string]> = [
  [/deepseek/gi, 'keespeed'],
  [/qwen/gi, 'newq'],
  [/minimax/gi, 'xaminim'],
  [/kimi/gi, 'imik'],
  [/glm/gi, 'mlg'],
  [/mimo/gi, 'omim'],
  [/nemotron/gi, 'notarmen'],
  [/grok/gi, 'korg'],
  [/gemini/gi, 'inimeg'],
  [/openai/gi, 'ianepo'],
  [/google/gi, 'elgoog'],
  [/gpt/gi, 'tpg'],
];

/** Residual family tokens Desktop still blocks after vendor masking (m2/k2/hy3). */
const FAMILY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/m2\.(\d)/gi, '2m.$1'],
  [/k2\.(\d)/gi, '2k.$1'],
  [/hy3/gi, '3yh'],
];

export function maskVendorText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of VENDOR_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of FAMILY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Mask only the wire model suffix in a gateway alias (`anthropic-provider__suffix`). */
export function maskGatewayModelId(aliasId: string): string {
  const sep = aliasId.indexOf('__');
  if (sep === -1) return maskVendorText(aliasId);
  return `${aliasId.slice(0, sep + 2)}${maskVendorText(aliasId.slice(sep + 2))}`;
}
