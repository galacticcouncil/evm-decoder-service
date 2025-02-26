const {Client} = require('pg');
const {ethers} = require('ethers');
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
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'blockchain_db',
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
    batchSize: parseInt(process.env.BATCH_SIZE || '100'),
    sleepTime: parseInt(process.env.SLEEP_TIME || '1000'),
    interval: parseInt(process.env.PROCESS_INTERVAL || '60000'),
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
        CREATE TABLE IF NOT EXISTS logs
        (
            id
            SERIAL
            PRIMARY
            KEY,
            event_id
            INTEGER
            UNIQUE
            REFERENCES
            event
        (
            id
        ),
            block_number BIGINT,
            transaction_hash TEXT,
            log_index INTEGER,
            address TEXT,
            event_name TEXT,
            decoded_data JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

        CREATE INDEX IF NOT EXISTS idx_logs_block_number ON logs(block_number);
        CREATE INDEX IF NOT EXISTS idx_logs_address ON logs(address);
        CREATE INDEX IF NOT EXISTS idx_logs_event_name ON logs(event_name);
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
        } else {
          console.log('Skipping process cycle - previous cycle still in progress');
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
      console.log('Already processing events, skipping this cycle');
      return;
    }

    this.isProcessing = true;
    console.log('Processing events...');

    try {
      let lastProcessedId = 0;
      let totalProcessed = 0;

      while (true) {
        const query = `
            SELECT e.id, e.data, e.block_number
            FROM event e
                     LEFT JOIN logs l ON e.id = l.event_id
            WHERE e.name = 'EVM.Log'
              AND l.id IS NULL
              AND e.id > $1
            ORDER BY e.block_number ASC, e.id ASC
                LIMIT $2
        `;

        const result = await this.client.query(query, [lastProcessedId, config.processing.batchSize]);

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

      console.log(`Total events processed in this run: ${totalProcessed}`);
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
      // Parse the event data
      const eventData = this.parseEventData(event.data);

      if (!eventData) {
        // If we can't parse the event data, store it as unparsed
        await this.storeUnparsedEvent(event.id, event.block_number, eventData);
        return;
      }

      // Try to decode using all available ABIs
      const decodedData = await this.tryDecodeWithAllAbis(eventData);

      if (decodedData) {
        // Store decoded event
        await this.storeDecodedEvent(
          event.id,
          event.block_number,
          eventData.transactionHash,
          eventData.logIndex,
          eventData.address,
          decodedData
        );
      } else {
        // Store as unparsed
        await this.storeUnparsedEvent(event.id, event.block_number, eventData);
      }
    } catch (error) {
      console.error(`Failed to decode event ${event.id}:`, error);
      // Store as unparsed to avoid reprocessing
      await this.storeUnparsedEvent(event.id, event.block_number, null);
    }
  }

  // Parse raw event data
  parseEventData(data) {
    try {
      // Handle string or object data
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

      // Extract relevant fields
      return {
        address: parsedData.address?.toLowerCase(),
        topics: parsedData.topics,
        data: parsedData.data,
        blockNumber: parsedData.blockNumber,
        transactionHash: parsedData.transactionHash,
        logIndex: parsedData.logIndex
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
        // Get all event fragments
        for (const eventFragment of Object.values(iface.events)) {
          try {
            // Check if topic matches event signature
            if (iface.getEvent(firstTopic)) {
              // Decode the log
              const log = {
                topics: eventData.topics,
                data: eventData.data,
                address: eventData.address
              };

              const decodedLog = iface.parseLog(log);

              // Return the decoded data
              return {
                contractName,
                eventName: decodedLog.name,
                args: this.argsToObject(decodedLog.args)
              };
            }
          } catch (error) {
            // Skip errors, try next event fragment
          }
        }
      } catch (error) {
        // Skip errors, try next interface
      }
    }

    return null;
  }

  // Convert array-like args to object
  argsToObject(args) {
    const result = {};

    // Handle numbered arguments
    for (let i = 0; i < Object.keys(args).length; i++) {
      if (args[i] !== undefined) {
        const value = args[i];
        result[i] = this.formatValue(value);
      }
    }

    // Handle named arguments
    for (const key of Object.keys(args)) {
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
    blockNumber,
    transactionHash,
    logIndex,
    address,
    decodedData
  ) {
    const query = `
        INSERT INTO logs (event_id, block_number, transaction_hash, log_index, address, event_name, decoded_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO
        UPDATE SET
            block_number = EXCLUDED.block_number,
            transaction_hash = EXCLUDED.transaction_hash,
            log_index = EXCLUDED.log_index,
            address = EXCLUDED.address,
            event_name = EXCLUDED.event_name,
            decoded_data = EXCLUDED.decoded_data
    `;

    const values = [
      eventId,
      blockNumber,
      transactionHash,
      logIndex,
      address,
      decodedData.eventName,
      JSON.stringify(decodedData)
    ];

    await this.client.query(query, values);
  }

  // Store unparsed event to avoid reprocessing
  async storeUnparsedEvent(
    eventId,
    blockNumber,
    eventData
  ) {
    const query = `
        INSERT INTO logs (event_id, block_number, decoded_data)
        VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING
    `;

    const values = [
      eventId,
      blockNumber,
      JSON.stringify({unparsed: true, raw: eventData})
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

// Main function to run the service
async function main() {
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

// Run the service
main();
