export interface LineItem { price: number; quantity: number; }
export const TAX_RATE = 0.08;

/** Calculates an order total in cents, including sales tax. */
export function calculateTotal(items: LineItem[]): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(subtotal * (1 + TAX_RATE));
}

export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
