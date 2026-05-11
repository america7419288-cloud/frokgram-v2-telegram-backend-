-- This runs when PostgreSQL container first starts
-- Create extensions we'll need

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- for text search
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- for better indexing

-- Create separate schema for better organization
-- (Optional but good practice)
CREATE SCHEMA IF NOT EXISTS premium;
CREATE SCHEMA IF NOT EXISTS stars;
CREATE SCHEMA IF NOT EXISTS stories;
CREATE SCHEMA IF NOT EXISTS nft;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE telegram_premium TO postgres;
GRANT ALL PRIVILEGES ON SCHEMA premium TO postgres;
GRANT ALL PRIVILEGES ON SCHEMA stars TO postgres;
GRANT ALL PRIVILEGES ON SCHEMA stories TO postgres;
GRANT ALL PRIVILEGES ON SCHEMA nft TO postgres;
