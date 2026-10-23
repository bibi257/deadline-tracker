// テスト・動作確認用の D1 互換シム（node:sqlite）。Worker が使う範囲（prepare/bind/first/all/run/batch）だけを実装
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async (col) => {
      const row = db.prepare(sql).get(...params);
      if (!row) return null;
      return col ? row[col] : { ...row };
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })), success: true }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of list) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
    _raw: db,
  };
}
