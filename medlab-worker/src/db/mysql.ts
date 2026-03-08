import mysql from "mysql2/promise";
import { MysqlConfig } from "../config";

export type MysqlPool = mysql.Pool;
export type MysqlConn = mysql.PoolConnection;

export function createMysqlPool(cfg: MysqlConfig): MysqlPool {
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
  });
}
