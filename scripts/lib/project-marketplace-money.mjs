const currencies = Object.freeze({ US: 'USD', UK: 'GBP', DE: 'EUR', CA: 'CAD' });

export function projectMarketplaceCurrency(marketplace) {
  return currencies[String(marketplace).trim().toUpperCase()] ?? null;
}

export function formatMarketplaceMoney(value, marketplace) {
  const currency = projectMarketplaceCurrency(marketplace);
  // Preserve the legacy US label; every other market retains an explicit unit.
  return currency === 'USD' ? `$${value.toFixed(2)}` : `${currency ?? '币种未验证'} ${value.toFixed(2)}`;
}
