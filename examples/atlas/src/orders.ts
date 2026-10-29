import { Database } from './database';
import { Logger } from './logger';
import { calculateTotal, formatCurrency } from './pricing';
import type { OrderInput } from './validation';

export interface Order { id: string; total: number; status: 'pending' | 'paid'; }

/** Coordinates order creation and persistence. */
export class OrderService {
  constructor(private database: Database, private logger: Logger) {}

  async createOrder(input: OrderInput): Promise<Order> {
    const total = calculateTotal(input.items);
    const order = await this.database.insert('orders', { total, status: 'pending' });
    this.logger.info(`Created order for ${formatCurrency(total)}`);
    return order as Order;
  }

  async getOrder(id: string) { return this.database.find('orders', id); }
}
