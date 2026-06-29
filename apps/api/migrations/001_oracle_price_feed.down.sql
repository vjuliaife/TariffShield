-- Migration 001: oracle_price_feed audit table and listener_state checkpoint
-- Down

DROP TABLE IF EXISTS oracle_price_feed;
DROP TABLE IF EXISTS listener_state;
