# EVM Decoder Service

This service decodes EVM data in Firesquid archive database.

## Features

- Loads ABIs from URLs and local files
- Processes EVM logs in batches
- Decodes logs using ethers.js
- Stores results in PostgreSQL database

## Setup

### Prerequisites

- Node.js (v14+)
- PostgreSQL database with Firesquid data

### Installation

```bash
# Install dependencies
npm install
```

### Configuration

Create a `.env` file with the following variables:

```
# Database configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=ingest

# ABI sources
ABI_URLS=https://example.com/abi1.json,https://example.com/abi2.json
ABI_DIR=./abis

# Processing configuration
BATCH_SIZE=1000
SLEEP_TIME=100
PROCESS_INTERVAL=5000
```

## Usage

### Running the Service

```bash
npm start
```

### Testing

The service includes multiple testing options:

#### Jest Tests

```bash
# Run all Jest tests
npm test

# Run with coverage
npm run test:coverage
```

This runs basic tests on the log decoding functionality using the test data from `test-data.csv`.

## Database Schema

The service creates and uses the following table:

```sql
CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    event_id CHARACTER(23) UNIQUE REFERENCES event(id),
    block_number BIGINT,
    address TEXT,
    event_name TEXT,
    abi TEXT,
    args JSONB
);
```
