-- One-time: create the dev role + database expected by .env.example / docker-compose.yml.
-- Run as a PostgreSQL superuser (often `postgres`), for example:
--   psql -U postgres -h localhost -p 5432 -f scripts/create-dev-db.sql
--
-- If `agentai` already exists, you may see "already exists" — safe to ignore.
-- Then set in .env:
--   DATABASE_URL="postgresql://agentai:name12345678@localhost:5432/agentai"
-- (Use the same host/port as the server you connected to above.)

CREATE ROLE agentai WITH LOGIN PASSWORD 'name12345678';
CREATE DATABASE agentai OWNER agentai;

-- If the role already exists but the password is wrong, run instead:
--   ALTER ROLE agentai WITH PASSWORD 'name12345678';
