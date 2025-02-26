# EVM Log Decoder Service

A service that periodically decodes Ethereum Virtual Machine (EVM) logs from a PostgreSQL database and stores the decoded data in a new table.

## Features

- Fetches and decodes EVM.Log events from a PostgreSQL database
- Loads ABIs from URLs (configurable via environment variables)
- Processes events in batches, ordered by block number
- Stores decoded events with references to original event IDs
- Docker and Docker Swarm ready deployment

## Configuration

The service is configured using environment variables:

### Database Configuration
- `DB_HOST`: PostgreSQL host (default: 'localhost')
- `DB_PORT`: PostgreSQL port (default: 5432)
- `DB_USER`: PostgreSQL user (default: 'postgres')
- `DB_PASSWORD`: PostgreSQL password (default: 'password')
- `DB_NAME`: PostgreSQL database name (default: 'blockchain_db')

### ABI Configuration
- `ABI_URLS`: Comma-separated list of URLs to fetch ABIs from
- `ABI_DIR`: Directory for local ABI files (default: './abis')

### Processing Configuration
- `BATCH_SIZE`: Number of events to process in each batch (default: 100)
- `SLEEP_TIME`: Time to sleep between batches in ms (default: 1000)
- `PROCESS_INTERVAL`: Service run interval in ms (default: 60000)

## Usage

### Local Development

1. Copy the environment example file:
   ```bash
   cp .env.example .env
   ```

2. Edit the `.env` file with your configuration

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start the service:
   ```bash
   npm start
   ```

### Docker

1. Build the Docker image:
   ```bash
   npm run docker:build
   ```

2. Run with Docker:
   ```bash
   npm run docker:run
   ```

### Docker Swarm

1. Build the Docker image:
   ```bash
   npm run docker:build
   ```

2. Deploy to Docker Swarm:
   ```bash
   npm run stack:deploy
   ```

   Or manually:
   ```bash
   docker stack deploy -c docker-compose.yml evm-decoder
   ```

## Database Schema

The service creates a `logs` table with the following structure:

```sql
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER UNIQUE REFERENCES event(id),
  block_number BIGINT,
  transaction_hash TEXT,
  log_index INTEGER,
  address TEXT,
  event_name TEXT,
  decoded_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

The table includes indexes for efficient querying:

```sql
CREATE INDEX IF NOT EXISTS idx_logs_block_number ON logs(block_number);
CREATE INDEX IF NOT EXISTS idx_logs_address ON logs(address);
CREATE INDEX IF NOT EXISTS idx_logs_event_name ON logs(event_name);
```

## License

MIT
