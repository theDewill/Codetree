/** Attaches a component name to application log messages. */
export class Logger {
  constructor(private component: string) {}
  info(message: string) { return `[${this.component}] ${message}`; }
  error(message: string) { return `[${this.component}] ERROR ${message}`; }
}
