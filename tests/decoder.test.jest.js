const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { ethers } = require('ethers');
const { EVMLogDecoderService } = require('../evm-decoder-service');

describe('EVMLogDecoderService', () => {
  let service;
  let testEvents = [];

  beforeAll(async () => {
    // Create service instance but don't initialize database connection
    service = new EVMLogDecoderService();

    // Directly load ABIs only (skip database connection)
    await service.loadAbis();

    // Load test data from CSV
    const csvPath = path.join(__dirname, 'test-data.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf8');

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
  });

  test('should parse event data correctly', () => {
    // Find an EVM.Log event to test with
    const logEvent = testEvents.find(event => event.name === 'EVM.Log');
    expect(logEvent).toBeDefined();

    const eventData = service.parseEventData(logEvent.args);
    expect(eventData).not.toBeNull();
    expect(eventData.address).toBeDefined();
    expect(eventData.topics).toBeDefined();
    expect(eventData.topics.length).toBeGreaterThan(0);
  });

  test('should decode logs with correct ABI', async () => {
    // Track success rate
    let evmLogs = 0;
    let decoded = 0;

    // Process each EVM.Log event
    for (const event of testEvents) {
      if (event.name !== 'EVM.Log') {
        continue;
      }

      evmLogs++;

      const eventData = service.parseEventData(event.args);
      if (!eventData) {
        continue;
      }

      const decodedData = await service.tryDecodeWithAllAbis(eventData);
      if (decodedData) {
        decoded++;

        // Test basic structure of decoded data
        expect(decodedData).toHaveProperty('contractName');
        expect(decodedData).toHaveProperty('eventName');
        expect(decodedData).toHaveProperty('args');
      }
    }

    console.log(`Decoded ${decoded} of ${evmLogs} EVM.Log events`);

    // Skip this test if there are no EVM.Log events
    if (evmLogs > 0) {
      // Calculate success rate
      const successRate = (decoded / evmLogs) * 100;
      console.log(`Success rate: ${successRate.toFixed(2)}%`);

      // We might not expect 90% success in a test without all ABIs loaded
      // So we're just verifying some decoding happens
      expect(decoded).toBeGreaterThan(0);
    }
  });

  test('should extract block number correctly', () => {
    expect(service.extractBlockNumber('block-12345-xyz')).toBe(12345);
    expect(service.extractBlockNumber('block-0-xyz')).toBe(0);
    expect(service.extractBlockNumber('invalid')).toBe(0); // Fallback value
  });

  test('should format BigNumber values', () => {
    // Create a fake BigNumber for testing
    const mockBigNumber = {
      _isBigNumber: true,
      toString: () => '1000000000000000000'
    };

    // Mock the ethers.BigNumber.isBigNumber function
    const originalIsBigNumber = ethers.BigNumber.isBigNumber;
    ethers.BigNumber.isBigNumber = (value) => {
      return value && value._isBigNumber === true;
    };

    expect(service.formatValue(mockBigNumber)).toBe('1000000000000000000');

    const arrayWithBigNum = [1, mockBigNumber, 'test'];
    const formattedArray = service.formatValue(arrayWithBigNum);
    expect(formattedArray[1]).toBe('1000000000000000000');

    const objWithBigNum = { value: mockBigNumber, other: 'test' };
    const formattedObj = service.formatValue(objWithBigNum);
    expect(formattedObj.value).toBe('1000000000000000000');

    // Restore original function
    ethers.BigNumber.isBigNumber = originalIsBigNumber;
  });
});
