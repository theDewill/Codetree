export type Handler = (request: Request) => unknown;

/** Small HTTP router. Registers handlers and applies shared middleware. */
export class Router {
  private routes = new Map<string, Handler>();
  private middleware: Handler[] = [];

  use(handler: Handler) { this.middleware.push(handler); }
  get(path: string, handler: Handler) { this.routes.set(`GET ${path}`, handler); }
  post(path: string, handler: Handler) { this.routes.set(`POST ${path}`, handler); }

  /** Returns the configured listener without starting a real network server. */
  listen(port: number) { return { port, routes: this.routes, middleware: this.middleware }; }
}
