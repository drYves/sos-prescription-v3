import mysql, { type Pool, type PoolOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';

export type DbClient = {
  pool: Pool;
  queryRows<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<ResultSetHeader>;
};

export function createDbClient(config?: PoolOptions): DbClient {
  const databaseUrl = process.env['DATABASE_URL'];
  const opts: PoolOptions = config ?? (databaseUrl
    ? { uri: databaseUrl, connectionLimit: Number(process.env['DB_POOL_SIZE'] ?? '8'), timezone: 'Z' }
    : { host: process.env['DB_HOST'] ?? '127.0.0.1', user: process.env['DB_USER'] ?? 'root', password: process.env['DB_PASSWORD'] ?? '', database: process.env['DB_NAME'] ?? 'app', connectionLimit: Number(process.env['DB_POOL_SIZE'] ?? '8'), timezone: 'Z' });

  const pool = mysql.createPool(opts);

  return {
    pool,
    async queryRows<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
      const [rows] = await pool.query<T>(sql, params);
      return rows;
    },
    async execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
      const [result] = await pool.execute<ResultSetHeader>(sql, params as never);
      return result;
    },
  };
}
