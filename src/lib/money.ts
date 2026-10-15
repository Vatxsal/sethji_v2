export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatPaise(paise: number): string {
  const hasPaise = paise % 100 !== 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export function formatBalance(paise: number): string {
  if (paise < 0) return `Advance: ${formatPaise(Math.abs(paise))}`;
  return formatPaise(paise);
}

export function formatQuantity(quantity: number): string {
  return String(quantity);
}
