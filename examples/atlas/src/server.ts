import { Router } from './router';
import { authenticate } from './auth';
import { OrderService } from './orders';
import { Database } from './database';
import { Logger } from './logger';
import { validateOrder } from './validation';

/** Application entry point. Connects storage, authentication, and HTTP routes. */
export function createServer(config: ServerConfig) {
  const logger = new Logger('atlas');
  const database = new Database(config.databaseUrl);
  const orders = new OrderService(database, logger);
  const router = new Router();

  router.use(authenticate);
  router.get('/health', () => database.health());
  router.post('/orders', async (request: Request) => {
    const input = validateOrder(request.body);
    return orders.createOrder(input);
  });
  return router.listen(config.port);
}

export interface ServerConfig {
  port: number;
  databaseUrl: string;
}
