/** In-memory example storage adapter with a database-like interface. */
export class Database {
  private records = new Map<string, unknown>();
  constructor(private url: string) {}

  async insert(table: string, data: object) {
    const record = { id: crypto.randomUUID(), ...data };
    this.records.set(`${table}:${record.id}`, record);
    return record;
  }
  async find(table: string, id: string) { return this.records.get(`${table}:${id}`); }
  health() { return { connected: Boolean(this.url), records: this.records.size }; }
}
