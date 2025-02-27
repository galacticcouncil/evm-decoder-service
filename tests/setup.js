// Mock the Client methods only where needed
// This allows us to still create a service instance but skip actual database operations
jest.mock('pg', () => {
  // The basic client that won't actually connect to a database
  const mockClient = {
    connect: jest.fn().mockResolvedValue(null),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(null)
  };

  return {
    Client: jest.fn(() => mockClient)
  };
});

// Silence console logs during tests to reduce noise
// Comment this out if you want to see the logs during test runs
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};
