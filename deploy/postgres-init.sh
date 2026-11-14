#!/bin/sh
# Runs only on first initialization of this project's PostgreSQL volume.
# The app owns its database/schema for explicit migrations, never cluster administration.
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\set VERBOSITY terse
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
CREATE ROLE galaxy LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
DO $$ BEGIN
  EXECUTE format('ALTER ROLE galaxy PASSWORD %L', rtrim(pg_read_file('/run/secrets/app_db_password'), E'\r\n'));
END $$;
ALTER DATABASE galaxy OWNER TO galaxy;
ALTER SCHEMA public OWNER TO galaxy;
SQL
