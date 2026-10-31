use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

#[derive(Debug)]
pub struct ConflictRow {
    pub path: String,
    pub conflict_copy: String,
    pub winner: String,
    pub at: String,
}

#[derive(Debug)]
pub struct RunRow {
    pub id: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: Option<String>,
}

impl Db {
    pub fn open(root: &Path) -> Result<Self> {
        let conn = Connection::open(root.join("index.db"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                outcome TEXT,
                detail TEXT
            );
            CREATE TABLE IF NOT EXISTS journal_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL,
                at TEXT NOT NULL,
                state TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                path TEXT NOT NULL,
                conflict_copy TEXT NOT NULL,
                winner TEXT NOT NULL,
                resolution TEXT
            );
            CREATE TABLE IF NOT EXISTS blob_cache (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                oid TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS search_state (
                path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                path UNINDEXED,
                content,
                tokenize = 'unicode61 remove_diacritics 2'
            );",
        )?;
        Ok(Self { conn })
    }

    fn now() -> String {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default()
    }

    pub fn begin_run(&self) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO sync_journal (started_at) VALUES (?1)",
            [Self::now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn event(&self, run: i64, state: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO journal_events (run_id, at, state) VALUES (?1, ?2, ?3)",
            rusqlite::params![run, Self::now(), state],
        )?;
        Ok(())
    }

    pub fn finish_run(&self, run: i64, outcome: &str, detail: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sync_journal SET finished_at = ?1, outcome = ?2, detail = ?3 WHERE id = ?4",
            rusqlite::params![Self::now(), outcome, detail, run],
        )?;
        Ok(())
    }

    pub fn record_conflict(&self, path: &str, copy: &str, winner: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conflicts (at, path, conflict_copy, winner) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![Self::now(), path, copy, winner],
        )?;
        Ok(())
    }

    pub fn conflicts(&self) -> Result<Vec<ConflictRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT at, path, conflict_copy, winner FROM conflicts ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(ConflictRow {
                at: r.get(0)?,
                path: r.get(1)?,
                conflict_copy: r.get(2)?,
                winner: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Stat cache: (size, mtime_ns) → blob oid, so unchanged files are
    /// never re-read or re-hashed (the git-index trick, in our own SQLite).
    pub fn cached_blob(&self, path: &str) -> Option<(i64, i64, String)> {
        self.conn
            .query_row(
                "SELECT size, mtime, oid FROM blob_cache WHERE path = ?1",
                [path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
    }

    pub fn put_blob_cache(&self, path: &str, size: i64, mtime: i64, oid: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO blob_cache (path, size, mtime, oid) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![path, size, mtime, oid],
        )?;
        Ok(())
    }

    pub fn last_run(&self) -> Result<Option<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, started_at, finished_at, outcome FROM sync_journal ORDER BY id DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map([], |r| {
            Ok(RunRow {
                id: r.get(0)?,
                started_at: r.get(1)?,
                finished_at: r.get(2)?,
                outcome: r.get(3)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn events_of(&self, run: i64) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT at, state FROM journal_events WHERE run_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([run], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Current search-index signature: every indexed path with the mtime and
    /// size it was indexed at. Used to detect drift between the index and the
    /// Markdown files on disk (the index is an optimization, never the source
    /// of truth — a mismatch means "rebuild", not "trust the index").
    pub fn search_signature(&self) -> Result<Vec<(String, i64, i64)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, mtime, size FROM search_state ORDER BY path")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Replace the whole search index in one transaction.
    /// Full rebuild on drift — simple, always converges, and cheap at vault
    /// sizes where searching still feels instant (well under 10k notes).
    pub fn search_rebuild(&self, docs: &[(String, String, i64, i64)]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM search_index", [])?;
        tx.execute("DELETE FROM search_state", [])?;
        {
            let mut ins_state =
                tx.prepare("INSERT INTO search_state (path, mtime, size) VALUES (?1, ?2, ?3)")?;
            let mut ins_doc =
                tx.prepare("INSERT INTO search_index (path, content) VALUES (?1, ?2)")?;
            for (path, content, mtime, size) in docs {
                ins_state.execute(rusqlite::params![path, mtime, size])?;
                ins_doc.execute(rusqlite::params![path, content])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Ranked full-text query. Returns (path, snippet) in bm25 relevance
    /// order. The snippet is plain text — the UI re-derives highlighted lines
    /// from the file itself, so no markup crosses this boundary.
    pub fn search_query(&self, fts_query: &str, limit: usize) -> Result<Vec<(String, String)>> {
        let sql = format!(
            "SELECT path, snippet(search_index, 1, '', '', '…', 18) \
             FROM search_index WHERE search_index MATCH ?1 \
             ORDER BY bm25(search_index) LIMIT {limit}"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([fts_query], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}
