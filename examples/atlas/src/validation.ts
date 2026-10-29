import type { LineItem } from './pricing';

export interface OrderInput { items: LineItem[]; }

/** Rejects missing or invalid line items before creating an order. */
export function validateOrder(body: unknown): OrderInput {
  if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items)) {
    throw new Error('Order items are required');
  }
  if (body.items.some(item => item.price < 0 || item.quantity < 1)) {
    throw new Error('Invalid line item');
  }
  return body as OrderInput;
}
