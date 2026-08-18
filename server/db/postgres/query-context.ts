import { AsyncLocalStorage } from "node:async_hooks";

import {
  type Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export class PostgresQueryContext {
  readonly #pool: Pool;
  readonly #transactionContext = new AsyncLocalStorage<PoolClient>();
  readonly #idleWaiters = new Set<() => void>();
  #activeRootTransactions = 0;
  #acceptingWork = true;
  #closePromise: Promise<void> | undefined;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    const client = this.#transactionContext.getStore();
    if (client) return await client.query<Row>(text, values);
    this.#assertOpen();
    return await this.#pool.query<Row>(text, values);
  }

  async transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const currentClient = this.#transactionContext.getStore();
    if (currentClient) return operation(currentClient);

    this.#assertOpen();
    this.#activeRootTransactions += 1;
    let client: PoolClient | undefined;
    let discardClient = false;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      try {
        const result = await this.#transactionContext.run(client, () =>
          operation(client!),
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          discardClient = true;
        });
        throw error;
      }
    } finally {
      client?.release(discardClient || undefined);
      this.#activeRootTransactions -= 1;
      if (this.#activeRootTransactions === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  close(): Promise<void> {
    if (this.#transactionContext.getStore()) {
      return Promise.reject(
        new Error("Cannot close PostgreSQL query context inside an active transaction"),
      );
    }
    if (!this.#closePromise) {
      this.#acceptingWork = false;
      this.#closePromise = (async () => {
        if (this.#activeRootTransactions > 0) {
          await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
        }
        await this.#pool.end();
      })();
    }
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (!this.#acceptingWork) {
      throw new Error("PostgreSQL query context is closed");
    }
  }
}
