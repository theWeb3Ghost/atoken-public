export function normalizeTokenAddress(chainId, address) {
  const a = String(address || '').trim();
  if (!a) return '';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();
  return a;
}

export function tokenId(chainId, address) {
  return `${String(chainId).toLowerCase()}:${normalizeTokenAddress(chainId, address)}`;
}

export function shortCa(address) {
  const a = String(address || '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}