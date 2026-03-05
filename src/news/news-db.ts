import Database from 'better-sqlite3';
import type { CryptoNews } from './types.js';

export interface NewsRow extends CryptoNews {
  age_hours: number;
}

export class NewsDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        coins TEXT NOT NULL,
        sentiment REAL NOT NULL,
        source TEXT NOT NULL,
        UNIQUE(title, date)
      )
    `);
  }

  insert(items: CryptoNews[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO news (title, date, coins, sentiment, source) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = this.db.transaction((rows: CryptoNews[]) => {
      for (const row of rows) {
        stmt.run(row.title, row.date, JSON.stringify(row.coins), row.sentiment, row.source);
      }
    });
    insertMany(items);
  }

  getRecent(hours: number): NewsRow[] {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT title, date, coins, sentiment, source,
        (julianday('now') - julianday(date)) * 24 AS age_hours
      FROM news
      WHERE date > ?
      ORDER BY date DESC
    `).all(cutoff) as any[];

    return rows.map(r => ({
      title: r.title,
      date: r.date,
      coins: JSON.parse(r.coins),
      sentiment: r.sentiment,
      source: r.source,
      age_hours: r.age_hours,
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM news').get() as any).n;
  }

  close(): void {
    this.db.close();
  }
}
