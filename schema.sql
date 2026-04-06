CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expiry_at INTEGER NOT NULL,
    status TEXT DEFAULT 'disconnected'
);
