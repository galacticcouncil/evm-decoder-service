const { Client } = require('pg');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configuration from environment variables
const config = {
  // PostgreSQL connection
  database: {
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
    database: process.env.DB_NAME || 'ingest',
  },
  // ABI sources
  abis: {
    // Parse comma-separated URLs
    urls: (process.env.ABI_URLS || '').split(',').filter(url => url.trim() !== ''),
    // Optional local directory for ABIs
    dir: process.env.ABI_DIR || path.join(__dirname, 'abis'),
  },
  // Processing configuration
  processing: {
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    sleepTime: parseInt(process.env.SLEEP_TIME || '100'),
    interval: parseInt(process.env.PROCESS_INTERVAL || '5000'),
  },
};

// Main decoder service class
class EVMLogDecoderService {
  constructor() {
    this.client = new Client(config.database);
    this.abiCache = new Map();
    this.interfaceCache = new Map();
    this.isRunning = false;
    this.isProcessing = false; // Flag to prevent concurrent processing

    // Log configuration on startup
    console.log('Starting EVM Log Decoder with configuration:');
    console.log('Database:', {
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      database: config.database.database,
      // Don't log password
    });
    console.log('ABI URLs:', config.abis.urls);
    console.log('ABI Directory:', config.abis.dir);
    console.log('Batch Size:', config.processing.batchSize);
    console.log('Process Interval:', config.processing.interval);
  }

  // Initialize the service
  async init() {
    try {
      // Load all ABIs
      await this.loadAbis();

      // Connect DB
      await this.client.connect();

      // Create logs table if it doesn't exist
      await this.createLogsTableIfNotExists();

      console.log('EVM Log Decoder Service initialized');
    } catch (error) {
      console.error('Failed to initialize service:', error);
      throw error;
    }
  }

  // Create logs table if it doesn't exist
  async createLogsTableIfNotExists() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS logs (
                                            id SERIAL PRIMARY KEY,
                                            event_id CHARACTER(23) UNIQUE REFERENCES event(id),
            block_number BIGINT,
            address TEXT,
            event_name TEXT,
            abi TEXT,
            args JSONB
            );

        CREATE INDEX IF NOT EXISTS idx_logs_block_number ON logs(block_number);
        CREATE INDEX IF NOT EXISTS idx_logs_address ON logs(address);
        CREATE INDEX IF NOT EXISTS idx_logs_event_name ON logs(event_name);
        CREATE INDEX IF NOT EXISTS idx_logs_abi ON logs(abi);
    `;

    await this.client.query(createTableQuery);
    console.log('Logs table created or already exists');
  }

  // Load all ABIs from URLs and/or local directory
  async loadAbis() {
    // Load ABIs from URLs
    await this.loadAbisFromUrls();

    // Load ABIs from local directory if specified
    if (fs.existsSync(config.abis.dir)) {
      await this.loadAbisFromDirectory();
    }

    console.log(`Loaded ${this.abiCache.size} total ABIs`);

    if (this.abiCache.size === 0) {
      console.warn('No ABIs loaded. Service may not be able to decode any events.');
    }
  }

  // Load ABIs from URLs
  async loadAbisFromUrls() {
    if (config.abis.urls.length === 0) {
      console.log('No ABI URLs specified');
      return;
    }

    console.log(`Loading ABIs from ${config.abis.urls.length} URLs`);

    for (const url of config.abis.urls) {
      try {
        if (!url || url.trim() === '') continue;

        console.log(`Fetching ABI from ${url}`);
        const response = await axios.get(url);

        if (response.status !== 200) {
          console.error(`Failed to fetch ABI from ${url}: ${response.status}`);
          continue;
        }

        const data = response.data;

        // Handle various response formats
        if (Array.isArray(data)) {
          // Single ABI as array
          const contractName = this.extractContractNameFromUrl(url);
          await this.addAbiToCache(contractName, data);
        } else if (typeof data === 'object') {
          if (data.abi) {
            // Standard JSON ABI format with abi property
            const contractName = data.contractName || this.extractContractNameFromUrl(url);
            await this.addAbiToCache(contractName, data.abi);
          } else if (Object.keys(data).length > 0) {
            // Multiple ABIs in one response
            for (const [contractName, abi] of Object.entries(data)) {
              if (Array.isArray(abi)) {
                await this.addAbiToCache(contractName, abi);
              } else if (typeof abi === 'object' && abi.abi) {
                await this.addAbiToCache(contractName, abi.abi);
              }
            }
          }
        }
      } catch (error) {
        console.error(`Failed to load ABI from ${url}:`, error);
      }
    }
  }

  // Extract contract name from URL
  extractContractNameFromUrl(url) {
    try {
      // Try to extract name from the URL
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      // Get the file name without extension
      const fileName = path.basename(pathname).split('.')[0];

      if (fileName && fileName !== '') {
        return fileName;
      }

      // Fallback: use domain + path hash
      const domain = urlObj.hostname;
      const pathHash = this.hashString(pathname).substring(0, 8);
      return `${domain}_${pathHash}`;
    } catch (error) {
      // Generate a random name if URL parsing fails
      return `contract_${Date.now()}`;
    }
  }

  // Simple string hashing
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  // Load ABIs from local directory
  async loadAbisFromDirectory() {
    try {
      const files = fs.readdirSync(config.abis.dir);
      console.log(`Found ${files.length} files in ABI directory`);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const filePath = path.join(config.abis.dir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);

          // Extract contract name from file name (remove .json extension)
          const contractName = file.replace('.json', '');

          // Handle standard JSON ABI format
          if (Array.isArray(data)) {
            await this.addAbiToCache(contractName, data);
          } else if (data.abi) {
            await this.addAbiToCache(contractName, data.abi);
          }
        } catch (error) {
          console.error(`Failed to load ABI from ${file}:`, error);
        }
      }
    } catch (error) {
      console.error(`Failed to read ABI directory:`, error);
    }
  }

  // Add ABI to cache and create interface
  async addAbiToCache(contractName, abi) {
    try {
      // Skip if no abi or already cached
      if (!abi || this.abiCache.has(contractName)) return;

      // Store ABI in cache
      this.abiCache.set(contractName, abi);

      // Create interface using ethers v5 syntax
      const iface = new ethers.utils.Interface(abi);
      this.interfaceCache.set(contractName, iface);

      console.log(`Loaded ABI for ${contractName}`);
    } catch (error) {
      console.error(`Failed to add ABI for ${contractName}:`, error);
    }
  }

  // Start the service
  async start() {
    if (this.isRunning) {
      console.log('Service is already running');
      return;
    }

    this.isRunning = true;

    // Schedule periodic processing
    setInterval(async () => {
      try {
        // Only start processing if we're not already processing events
        if (!this.isProcessing) {
          await this.processEvents();
        }
      } catch (error) {
        console.error('Error processing events:', error);
        this.isProcessing = false; // Reset flag in case of error
      }
    }, config.processing.interval);

    // Do initial processing immediately
    await this.processEvents();

    console.log('EVM Log Decoder Service started');
  }

  // Process a batch of events
  async processEvents() {
    // Prevent concurrent processing
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    const { batchSize } = config.processing;

    try {
      let lastProcessedId = '';
      let totalProcessed = 0;

      while (true) {
        const query = `
            SELECT e.id, e.args, e.block_id
            FROM event e
                     LEFT JOIN logs l ON e.id = l.event_id
            WHERE e.name = 'EVM.Log'
              AND l.id IS NULL
              AND e.id > $1
            ORDER BY e.block_id ASC, e.id ASC
                LIMIT $2
        `;

        const result = await this.client.query(query, [lastProcessedId, batchSize]);

        if (result.rows.length === 0) {
          break;
        }

        for (const row of result.rows) {
          try {
            await this.decodeAndStoreEvent(row);
            lastProcessedId = row.id;
            totalProcessed++;
          } catch (error) {
            console.error(`Error processing event id ${row.id}:`, error);
          }
        }

        console.log(`Processed ${result.rows.length} events`);

        // If no events were processed, we're done
        if (result.rows.length === 0) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, config.processing.sleepTime));
      }

      if (totalProcessed > batchSize) {
        console.log(`Total events processed in this run: ${totalProcessed}`);
      }
    } catch (error) {
      console.error('Error in process events:', error);
    } finally {
      // Always release the processing lock when done
      this.isProcessing = false;
    }
  }

  // Decode and store a single event
  async decodeAndStoreEvent(event) {
    try {
      // The event.args field contains the log data we need to decode
      // This could be a string that needs parsing or an already parsed object
      const logData = this.parseEventData(event.args);

      if (!logData) {
        // If we can't parse the log data, store it as unparsed
        await this.storeUnparsedEvent(event.id, event.block_id, null);
        return;
      }

      // Try to decode using all available ABIs
      const decodedData = await this.tryDecodeWithAllAbis(logData);

      if (decodedData) {
        // Store decoded event (we no longer need transaction_hash and log_index)
        await this.storeDecodedEvent(
          event.id,
          event.block_id,
          null, // transactionHash no longer used
          null, // logIndex no longer used
          logData.address,
          decodedData
        );
      } else {
        // Store as unparsed
        await this.storeUnparsedEvent(event.id, event.block_id, typeof event.args === 'string' ? JSON.parse(event.args) : event.args);
      }
    } catch (error) {
      console.error(`Failed to decode event ${event.id}:`, error);
      // Store as unparsed to avoid reprocessing
      await this.storeUnparsedEvent(event.id, event.block_id, null);
    }
  }

  // Parse raw event data (from args field)
  parseEventData(rawEventData) {
    try {
      // Handle string or object data
      const eventArgs = typeof rawEventData === 'string' ? JSON.parse(rawEventData) : rawEventData;

      // For EVM.Log events, the structure is:
      // {
      //   "log": {
      //     "data": "0x...",
      //     "topics": ["0x...", ...],
      //     "address": "0x..."
      //   }
      //   // ... possibly other fields
      // }

      // Check if we have the log field
      if (!eventArgs || !eventArgs.log) {
        console.error('Event data missing log field:', eventArgs);
        return null;
      }

      const log = eventArgs.log;

      // Validate that we have the required fields for an EVM log
      if (!log.topics || !log.address) {
        console.error('Log data missing required fields:', log);
        return null;
      }

      // Extract and return the fields needed for log decoding
      // Note: Some fields might be in the parent object and not in the log object
      return {
        address: log.address?.toLowerCase(),
        topics: log.topics,
        data: log.data,
        blockNumber: eventArgs.blockNumber,
        transactionHash: eventArgs.transactionHash,
        logIndex: eventArgs.logIndex
      };
    } catch (error) {
      console.error('Failed to parse event data:', error);
      return null;
    }
  }

  // Try to decode the log with all available interfaces
  async tryDecodeWithAllAbis(eventData) {
    if (!eventData.topics || eventData.topics.length === 0) {
      return null;
    }

    const firstTopic = eventData.topics[0];

    // Try each interface
    for (const [contractName, iface] of this.interfaceCache.entries()) {
      try {
        // Check if this interface can decode the log
        if (iface.getEvent(firstTopic)) {
          // Create the log object expected by ethers
          const log = {
            topics: eventData.topics,
            data: eventData.data,
            address: eventData.address
          };

          // Attempt to decode with this interface
          const decodedLog = iface.parseLog(log);

          // Return the decoded data
          return {
            contractName,
            eventName: decodedLog.name,
            args: decodedLog.args
          };
        }
      } catch (error) {
        // Skip errors, try next interface
      }
    }

    return null;
  }

  // Convert array-like args to object with only named args
  getNamedArgs(args) {
    const result = {};

    // Only include named arguments (skip numbered ones)
    for (const key of Object.keys(args)) {
      // Check if the key is not a number
      if (isNaN(Number(key))) {
        const value = args[key];
        result[key] = this.formatValue(value);
      }
    }

    return result;
  }

  // Format values for storing in JSON
  formatValue(value) {
    if (ethers.BigNumber.isBigNumber(value)) {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value.map(v => this.formatValue(v));
    }

    if (value !== null && typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) {
        result[key] = this.formatValue(value[key]);
      }
      return result;
    }

    return value;
  }

  // Store decoded event in the logs table
  async storeDecodedEvent(
    eventId,
    blockId,
    transactionHash,
    logIndex,
    address,
    decodedData
  ) {
    const query = `
        INSERT INTO logs (
            event_id, block_number, address, event_name, abi, args
        ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (event_id) DO UPDATE SET
            block_number = EXCLUDED.block_number,
                                          address = EXCLUDED.address,
                                          event_name = EXCLUDED.event_name,
                                          abi = EXCLUDED.abi,
                                          args = EXCLUDED.args
    `;

    // Convert blockId (which is a character type) to a number for the block_number field
    const blockNumber = this.extractBlockNumber(blockId);

    // Get only named arguments (no numbered fields)
    const namedArgs = this.getNamedArgs(decodedData.args);

    const values = [
      eventId,
      blockNumber,
      address,
      decodedData.eventName,
      decodedData.contractName, // Store contract name as ABI identifier
      JSON.stringify(namedArgs)  // Store only named arguments
    ];

    await this.client.query(query, values);
  }

  // Extract numeric block number from block_id string
  extractBlockNumber(blockId) {
    try {
      // Try to extract the numeric part of the block ID
      // Assuming format like 'block-123456-789' or similar
      const matches = blockId.match(/\d+/g);
      if (matches && matches.length > 0) {
        return parseInt(matches[0], 10);
      }
      return 0; // Fallback value
    } catch (error) {
      console.error(`Error extracting block number from ${blockId}:`, error);
      return 0; // Fallback value on error
    }
  }

  // Store unparsed event to avoid reprocessing
  async storeUnparsedEvent(
    eventId,
    blockId,
    eventData
  ) {
    const query = `
        INSERT INTO logs (
            event_id, block_number, args
        ) VALUES ($1, $2, $3)
            ON CONFLICT (event_id) DO NOTHING
    `;

    // Convert blockId to number
    const blockNumber = this.extractBlockNumber(blockId);

    const values = [
      eventId,
      blockNumber,
      JSON.stringify({ unparsed: true, raw: eventData })
    ];

    await this.client.query(query, values);
  }

  // Stop the service
  async stop() {
    this.isRunning = false;
    await this.client.end();
    console.log('EVM Log Decoder Service stopped');
  }
}

// Test decoder with sample events from CSV
async function testWithSampleEvents(csvPath) {
  console.log(`Testing decoder with sample events from ${csvPath}`);

  // Create service instance
  const service = new EVMLogDecoderService();

  try {
    // Initialize service
    await service.init();

    // Load test data from CSV
    const Papa = require('papaparse');
    const fs = require('fs');

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    let testEvents = [];

    await new Promise((resolve, reject) => {
      Papa.parse(csvContent, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
          testEvents = results.data;
          console.log(`Loaded ${testEvents.length} test events`);
          resolve();
        },
        error: (error) => {
          console.error('Failed to parse CSV:', error);
          reject(error);
        }
      });
    });

    // Track test results
    const results = {
      total: testEvents.length,
      evmLogs: 0,
      decoded: 0,
      failed: 0,
      details: []
    };

    // Process each event
    for (const event of testEvents) {
      try {
        // Only process EVM.Log events
        if (event.name !== 'EVM.Log') {
          continue;
        }

        results.evmLogs++;

        // Use the service's parseEventData method directly on the args field
        const eventData = service.parseEventData(event.args);

        if (!eventData) {
          results.failed++;
          results.details.push({
            id: event.id,
            success: false,
            error: 'Event data missing required fields or malformed'
          });
          continue;
        }

        // Try to decode
        const decodedData = await service.tryDecodeWithAllAbis(eventData);

        if (decodedData) {
          results.decoded++;
          results.details.push({
            id: event.id,
            blockId: event.block_id,
            success: true,
            decodedData
          });
        } else {
          results.failed++;
          results.details.push({
            id: event.id,
            blockId: event.block_id,
            success: false,
            error: 'Could not decode with any ABI'
          });
        }
      } catch (error) {
        results.failed++;
        results.details.push({
          id: event.id,
          blockId: event.block_id,
          success: false,
          error: error.message
        });
      }
    }

    // Print results
    console.log('\n===== Test Results =====');
    console.log(`Total events: ${results.total}`);
    console.log(`EVM.Log events: ${results.evmLogs}`);
    console.log(`Successfully decoded: ${results.decoded}`);
    console.log(`Failed to decode: ${results.failed}`);

    if (results.evmLogs > 0) {
      const successRate = (results.decoded / results.evmLogs) * 100;
      console.log(`Success rate: ${successRate.toFixed(2)}%`);

      if (successRate >= 90) {
        console.log('✅ TEST PASSED (>= 90% success rate)');
      } else {
        console.log('❌ TEST FAILED (< 90% success rate)');
      }
    }

    // Save detailed results to file
    fs.writeFileSync(
      'test-results.json',
      JSON.stringify(results, null, 2)
    );

    console.log(`Detailed results saved to test-results.json`);

    return results;
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    // Stop service
    await service.stop();
  }
}

// Main function to run the service
async function main() {
  // Check if running in test mode
  const testArg = process.argv.find(arg => arg.startsWith('--test='));

  if (testArg) {
    const csvPath = testArg.split('=')[1];
    await testWithSampleEvents(csvPath);
    process.exit(0);
    return;
  }

  // Normal operation
  const service = new EVMLogDecoderService();

  try {
    await service.init();
    await service.start();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Received SIGINT. Shutting down...');
      await service.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM. Shutting down...');
      await service.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start service:', error);
    process.exit(1);
  }
}

// Export for testing
module.exports = { EVMLogDecoderService, testWithSampleEvents };

// If script is run directly (not imported)
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
