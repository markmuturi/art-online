// Prices are stored as whole cents. KES is the only currency at launch.
export function formatKes(cents: number): string {
  const amount = cents / 100;
  const whole = Number.isInteger(amount);
  return `KES ${amount.toLocaleString("en-KE", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
