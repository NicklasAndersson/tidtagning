CREATE TABLE IF NOT EXISTS scans (
  runner_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  scanned_by TEXT,
  lat REAL,
  long REAL,
  PRIMARY KEY (runner_id, station_id)
);

CREATE TABLE IF NOT EXISTS participants (
  startnummer TEXT PRIMARY KEY,
  namn TEXT NOT NULL,
  klass TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  namn TEXT NOT NULL,
  typ TEXT NOT NULL DEFAULT 'checkpoint',
  lat REAL,
  long REAL,
  ordning INTEGER
);

CREATE TABLE IF NOT EXISTS funktionarer (
  token TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  namn TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gast_rapporter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kommentar TEXT,
  lat REAL,
  long REAL
);

CREATE TABLE IF NOT EXISTS race_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  namn TEXT,
  start_time INTEGER,
  gpx TEXT,
  logo TEXT
);
INSERT OR IGNORE INTO race_settings (id, namn, start_time) VALUES (1, NULL, NULL);

-- Ögonblicksbild av loppnamn + resultat innan nollställning (krav 4.4: namnet ska följa med arkivet)
CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namn TEXT,
  archived_at INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  html TEXT NOT NULL
);
