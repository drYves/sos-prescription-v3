// src/db/mysql.ts
export interface MysqlConn {
  release(): void;
}

export interface MysqlPool {
  end(): Promise<void>;
}

export function createMysqlPool(): never {
  throw new Error("Direct MySQL access has been removed. Use the REST bridge instead.");
}
