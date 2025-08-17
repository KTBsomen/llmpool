 
const {
  LLMPool,
  ConfigManager,
  Provider,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  PROVIDERS,
  createTextMessage,
  createImageMessage
} = require('../src/llm-pool');

const fs = require('fs').promises;
const path = require('path');

// Mock axios for testing
jest.mock('axios');
const axios = require('axios');

describe('LLM Pool Manager', () => {
  let testConfigPath;
  let validConfig;

  beforeAll(async () => {
    testConfigPath = path.join(__dirname, 'test-config.json');
    validConfig = {
      providers: [
        {
          name: 'test-openai',
          type: 'openai',
          api_key: 'test-key',
          base_url: 'https://api.openai.com/v1',
          model: 'gpt-3.5-turbo',
          priority: 1,
          requests_per_minute: 100,
          requests_per_day: 1000
        },
        {
          name: 'test-anthropic',
          type: 'anthropic',
          api_key: 'test-key-2',
          base_url: 'https://api.anthropic.com/v1',
          model: 'claude-3-sonnet-20240229',
          priority: 2,
          requests_per_minute: 50,
          requests_per_day: 500
        }
      ]
    };

    await fs.writeFile(testConfigPath, JSON.stringify(validConfig));
  });

  afterAll(async () => {
    try {
      await fs.unlink(testConfigPath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  });

  describe('Provider Class', () => {
    test('should create valid provider', () => {
      const config = validConfig.providers[0];
      const provider = new Provider(config);

      expect(provider.name).toBe(config.name);
      expect(provider.type).toBe(config.type);
      expect(provider.model).toBe(config.model);
      expect(provider.canUse()).toBe(true);
    });

    test('should validate required fields', () => {
      const invalidConfig = { name: 'test' }; // Missing required fields

      expect(() => new Provider(invalidConfig)).toThrow(ConfigurationError);
    });

    test('should handle rate limiting', () => {
      const config = { ...validConfig.providers[0], requests_per_minute: 1 };
      const provider = new Provider(config);

      expect(provider.canUse()).toBe(true);

      // Simulate request
      provider.recordRequest(true, 100, 10, 0.001);
      expect(provider.canUse()).toBe(false);

      // Reset rate limit (simulate time passing)
      provider.lastReset = new Date(Date.now() - 61000); // 61 seconds ago
      expect(provider.canUse()).toBe(true);
    });

    test('should handle circuit breaker', () => {
      const config = { ...validConfig.providers[0], circuit_breaker_threshold: 2 };
      const provider = new Provider(config);

      // Record failures
      provider.recordRequest(false, 100);
      provider.recordRequest(false, 100);

      expect(provider.isCircuitBreakerOpen).toBe(true);
      expect(provider.canUse()).toBe(false);
    });

    test('should calculate success rate', () => {
      const provider = new Provider(validConfig.providers[0]);

      provider.recordRequest(true, 100);
      provider.recordRequest(true, 100);
      provider.recordRequest(false, 100);

      expect(provider.getSuccessRate()).toBe(66.66666666666666);
    });

    test('should track response times', () => {
      const provider = new Provider(validConfig.providers[0]);

      provider.recordRequest(true, 100);
      provider.recordRequest(true, 200);
      provider.recordRequest(true, 300);

      expect(provider.getAverageResponseTime()).toBe(200);
    });
  });

  describe('ConfigManager Class', () => {
    test('should load local configuration', async () => {
      const configManager = new ConfigManager({ configPath: testConfigPath });
      const config = await configManager.loadConfig();

      expect(config).toEqual(validConfig);
    });

    test('should validate configuration', async () => {
      const invalidConfigPath = path.join(__dirname, 'invalid-config.json');
      const invalidConfig = { providers: [{ name: 'invalid' }] };

      await fs.writeFile(invalidConfigPath, JSON.stringify(invalidConfig));

      const configManager = new ConfigManager({ configPath: invalidConfigPath });

      await expect(configManager.loadConfig()).rejects.toThrow(ConfigurationError);

      await fs.unlink(invalidConfigPath);
    });

    test('should detect configuration changes', async () => {
      const configManager = new ConfigManager({ configPath: testConfigPath });
      
      // Load initial config
      await configManager.loadConfig();
      const initialChecksum = configManager.currentChecksum;

      // Modify config
      const modifiedConfig = {
        ...validConfig,
        providers: [...validConfig.providers, {
          name: 'new-provider',
          type: 'groq',
          api_key: 'new-key',
          base_url: 'https://api.groq.com/openai/v1',
          model: 'mixtral-8x7b-32768',
          priority: 3,
          requests_per_minute: 30
        }]
      };

      await fs.writeFile(testConfigPath, JSON.stringify(modifiedConfig));

      // Load modified config
      await configManager.loadConfig();
      expect(configManager.currentChecksum).not.toBe(initialChecksum);

      // Restore original config
      await fs.writeFile(testConfigPath, JSON.stringify(validConfig));
    });

    test('should handle remote configuration', async () => {
      const mockResponse = { data: validConfig };
      axios.get.mockResolvedValue(mockResponse);

      const configManager = new ConfigManager({ 
        configUrl: 'https://example.com/config.json' 
      });
      
      const config = await configManager.loadConfig();
      expect(config).toEqual(validConfig);
      expect(axios.get).toHaveBeenCalledWith(
        'https://example.com/config.json',
        expect.any(Object)
      );
    });

    test('should handle remote configuration errors', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));

      const configManager = new ConfigManager({ 
        configUrl: 'https://example.com/invalid-config.json' 
      });

      await expect(configManager.loadConfig()).rejects.toThrow(ConfigurationError);
    });
  });

  describe('LLMPool Class', () => {
    let pool;

    beforeEach(async () => {
      pool = new LLMPool({ configPath: testConfigPath });
      await pool.initialize();
    });

    afterEach(async () => {
      await pool.shutdown();
    });

    test('should initialize with providers', async () => {
      expect(pool.providers.size).toBe(2);
      expect(pool.providers.has('test-openai')).toBe(true);
      expect(pool.providers.has('test-anthropic')).toBe(true);
    });

    test('should select provider by priority', () => {
      const provider = pool.selectProvider();
      expect(provider.name).toBe('test-openai'); // Priority 1
    });

    test('should exclude rate-limited providers', () => {
      const provider1 = pool.providers.get('test-openai');
      provider1.requestCount = provider1.requestsPerMinute; // Max out requests

      const provider = pool.selectProvider();
      expect(provider.name).toBe('test-anthropic');
    });

    test('should format requests for different providers', () => {
      const request = {
        messages: [createTextMessage('user', 'Hello')],
        temperature: 0.7,
        max_tokens: 100
      };

      const openaiProvider = pool.providers.get('test-openai');
      const openaiRequest = pool.formatRequestForProvider(openaiProvider, request);
      
      expect(openaiRequest).toHaveProperty('messages');
      expect(openaiRequest).toHaveProperty('model', 'gpt-3.5-turbo');

      const anthropicProvider = pool.providers.get('test-anthropic');
      const anthropicRequest = pool.formatRequestForProvider(anthropicProvider, request);
      
      expect(anthropicRequest).toHaveProperty('messages');
      expect(anthropicRequest).toHaveProperty('model', 'claude-3-sonnet-20240229');
    });

    test('should handle successful requests', async () => {
      const mockResponse = {
        data: {
          id: 'test-id',
          choices: [{ message: { content: 'Hello world' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          model: 'gpt-3.5-turbo'
        }
      };

      axios.post.mockResolvedValue({ status: 200, ...mockResponse });

      const response = await pool.chat({
        messages: [createTextMessage('user', 'Hello')]
      });

      expect(response.content).toBe('Hello world');
      expect(response.provider).toBe('test-openai');
      expect(response.usage.total_tokens).toBe(12);
    });

    test('should handle provider failures and retry', async () => {
      let callCount = 0;
      axios.post.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          status: 200,
          data: {
            id: 'test-id',
            choices: [{ message: { content: 'Success on retry' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
          }
        });
      });

      const response = await pool.chat({
        messages: [createTextMessage('user', 'Hello')]
      });

      expect(response.content).toBe('Success on retry');
      expect(callCount).toBe(2); // First call failed, second succeeded
    });

    test('should handle rate limit errors', async () => {
      axios.post.mockResolvedValue({
        status: 429,
        headers: { 'retry-after': '60' },
        data: { error: { message: 'Rate limit exceeded' } }
      });

      await expect(pool.chat({
        messages: [createTextMessage('user', 'Hello')]
      })).rejects.toThrow(RateLimitError);
    });

    test('should get provider statistics', () => {
      const stats = pool.getProviderStats();
      
      expect(stats).toHaveProperty('test-openai');
      expect(stats).toHaveProperty('test-anthropic');
      
      expect(stats['test-openai']).toHaveProperty('health');
      expect(stats['test-openai']).toHaveProperty('usage');
      expect(stats['test-openai']).toHaveProperty('performance');
    });

    test('should get pool health', () => {
      const health = pool.getPoolHealth();
      
      expect(health).toHaveProperty('totalProviders', 2);
      expect(health).toHaveProperty('availableProviders');
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('providers');
    });
  });

  describe('Message Helpers', () => {
    test('should create text message', () => {
      const message = createTextMessage('user', 'Hello world');
      
      expect(message).toEqual({
        role: 'user',
        content: 'Hello world'
      });
    });

    test('should create image message', () => {
      const message = createImageMessage('user', 'What is this?', 'data:image/jpeg;base64,abc123');
      
      expect(message).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } }
        ]
      });
    });
  });

  describe('Error Handling', () => {
    test('should create ProviderError with correct properties', () => {
      const error = new ProviderError('Test error', 'test-provider', 500, true);
      
      expect(error.name).toBe('ProviderError');
      expect(error.message).toBe('Test error');
      expect(error.provider).toBe('test-provider');
      expect(error.statusCode).toBe(500);
      expect(error.retryable).toBe(true);
    });

    test('should create RateLimitError with reset time', () => {
      const error = new RateLimitError('Rate limited', 'test-provider', 60);
      
      expect(error.name).toBe('RateLimitError');
      expect(error.provider).toBe('test-provider');
      expect(error.resetTime).toBe(60);
    });

    test('should create ConfigurationError', () => {
      const error = new ConfigurationError('Invalid config');
      
      expect(error.name).toBe('ConfigurationError');
      expect(error.message).toBe('Invalid config');
    });
  });

  describe('Token Estimation', () => {
    let pool;

    beforeEach(async () => {
      pool = new LLMPool({ 
        configPath: testConfigPath,
        useTokenCounting: true 
      });
      await pool.initialize();
    });

    afterEach(async () => {
      await pool.shutdown();
    });

    test('should estimate tokens for text messages', () => {
      const messages = [
        createTextMessage('user', 'Hello world'),
        createTextMessage('assistant', 'Hi there!')
      ];

      const tokens = pool.estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    test('should handle mixed content messages', () => {
      const messages = [
        createImageMessage('user', 'What is this?', 'data:image/jpeg;base64,abc123')
      ];

      const tokens = pool.estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('Cost Calculation', () => {
    test('should calculate request cost', () => {
      const provider = new Provider({
        ...validConfig.providers[0],
        input_token_price: 0.5,  // $0.5 per 1M tokens
        output_token_price: 1.5  // $1.5 per 1M tokens
      });

      const pool = new LLMPool({ configPath: testConfigPath });
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150
      };

      const cost = pool.calculateCost(provider, usage);
      expect(cost).toBe((100 * 0.5 + 50 * 1.5) / 1000000);
    });
  });

  describe('Integration Tests', () => {
    test('should handle concurrent requests', async () => {
      const pool = new LLMPool({ configPath: testConfigPath });
      await pool.initialize();

      // Mock successful responses
      axios.post.mockResolvedValue({
        status: 200,
        data: {
          id: 'test-id',
          choices: [{ message: { content: 'Concurrent response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        }
      });

      const promises = Array(10).fill(0).map((_, i) => 
        pool.chat({
          messages: [createTextMessage('user', `Request ${i}`)]
        })
      );

      const responses = await Promise.allSettled(promises);
      const successful = responses.filter(r => r.status === 'fulfilled').length;

      expect(successful).toBeGreaterThan(0);

      await pool.shutdown();
    });
  });
});

// Test utilities
class TestUtils {
  static createMockProvider(name, type = 'openai', overrides = {}) {
    return {
      name,
      type,
      api_key: 'test-key',
      base_url: 'https://api.test.com/v1',
      model: 'test-model',
      priority: 1,
      requests_per_minute: 100,
      requests_per_day: 1000,
      ...overrides
    };
  }

  static createMockResponse(content = 'Test response', provider = 'openai') {
    const responses = {
      openai: {
        status: 200,
        data: {
          id: 'test-id',
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          model: 'gpt-3.5-turbo'
        }
      },
      anthropic: {
        status: 200,
        data: {
          id: 'test-id',
          content: [{ text: content }],
          usage: { input_tokens: 10, output_tokens: 2 },
          model: 'claude-3-sonnet-20240229'
        }
      }
    };

    return responses[provider] || responses.openai;
  }

  static async createTestConfig(providers = null) {
    const config = {
      providers: providers || [
        TestUtils.createMockProvider('test-provider-1'),
        TestUtils.createMockProvider('test-provider-2', 'anthropic', { priority: 2 })
      ]
    };

    const configPath = path.join(__dirname, `test-config-${Date.now()}.json`);
    await fs.writeFile(configPath, JSON.stringify(config));
    
    return { config, configPath };
  }

  static async cleanupTestConfig(configPath) {
    try {
      await fs.unlink(configPath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }

  static mockAxiosResponse(responses) {
    let callCount = 0;
    axios.post.mockImplementation(() => {
      const response = Array.isArray(responses) ? responses[callCount++] : responses;
      if (response instanceof Error) {
        return Promise.reject(response);
      }
      return Promise.resolve(response);
    });
  }
}

// Performance Tests
describe('Performance Tests', () => {
  let pool;
  let configPath;

  beforeEach(async () => {
    const { config, configPath: path } = await TestUtils.createTestConfig([
      TestUtils.createMockProvider('fast-provider', 'openai', { priority: 1 }),
      TestUtils.createMockProvider('slow-provider', 'anthropic', { priority: 2 }),
      TestUtils.createMockProvider('backup-provider', 'groq', { priority: 3 })
    ]);
    
    configPath = path;
    pool = new LLMPool({ configPath });
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle high throughput requests', async () => {
    TestUtils.mockAxiosResponse(TestUtils.createMockResponse('Fast response'));

    const startTime = Date.now();
    const promises = Array(100).fill(0).map((_, i) => 
      pool.chat({
        messages: [createTextMessage('user', `High throughput test ${i}`)]
      }).catch(() => null) // Don't fail the test on individual request failures
    );

    const results = await Promise.allSettled(promises);
    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;

    console.log(`Processed ${successCount}/100 requests in ${duration}ms`);
    expect(successCount).toBeGreaterThan(50); // At least 50% success rate
    expect(duration).toBeLessThan(30000); // Complete within 30 seconds
  });

  test('should maintain performance under provider failures', async () => {
    // First provider fails, others succeed
    let callCount = 0;
    axios.post.mockImplementation(() => {
      callCount++;
      if (callCount <= 10) {
        return Promise.reject(new Error('Provider temporarily down'));
      }
      return Promise.resolve(TestUtils.createMockResponse('Backup success'));
    });

    const promises = Array(20).fill(0).map((_, i) => 
      pool.chat({
        messages: [createTextMessage('user', `Failover test ${i}`)]
      }).catch(() => null)
    );

    const results = await Promise.allSettled(promises);
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;

    expect(successCount).toBeGreaterThan(5); // Some requests should succeed via fallback
  });
});

// Security Tests
describe('Security Tests', () => {
  test('should sanitize API keys in provider stats', async () => {
    const pool = new LLMPool();
    const provider = new Provider({
      name: 'security-test',
      type: 'openai',
      api_key: 'very-secret-key-12345',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-3.5-turbo'
    });

    pool.providers.set('security-test', provider);

    const publicProviders = pool.GetProviders ? pool.GetProviders() : Array.from(pool.providers.values());
    
    // API keys should be hidden in any public interface
    expect(JSON.stringify(publicProviders)).not.toContain('very-secret-key-12345');
  });

  test('should validate request inputs', async () => {
    const { configPath } = await TestUtils.createTestConfig();
    const pool = new LLMPool({ configPath });
    await pool.initialize();

    // Test with invalid messages
    await expect(pool.chat({ messages: null })).rejects.toThrow();
    await expect(pool.chat({ messages: 'invalid' })).rejects.toThrow();
    await expect(pool.chat({})).rejects.toThrow();

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle malformed configuration gracefully', async () => {
    const malformedConfig = {
      providers: [
        {
          name: 'malformed',
          type: 'unknown-provider', // Invalid provider type
          api_key: 'test',
          base_url: 'invalid-url',
          model: 'test'
        }
      ]
    };

    const configPath = path.join(__dirname, 'malformed-config.json');
    await fs.writeFile(configPath, JSON.stringify(malformedConfig));

    const configManager = new ConfigManager({ configPath });
    await expect(configManager.loadConfig()).rejects.toThrow(ConfigurationError);

    await TestUtils.cleanupTestConfig(configPath);
  });
});

// Edge Cases
describe('Edge Cases', () => {
  test('should handle empty provider list', async () => {
    const emptyConfig = { providers: [] };
    const configPath = path.join(__dirname, 'empty-config.json');
    await fs.writeFile(configPath, JSON.stringify(emptyConfig));

    const pool = new LLMPool({ configPath });
    await pool.initialize();

    await expect(pool.chat({
      messages: [createTextMessage('user', 'Hello')]
    })).rejects.toThrow();

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle all providers rate-limited', async () => {
    const { configPath } = await TestUtils.createTestConfig([
      TestUtils.createMockProvider('limited-1', 'openai', { requests_per_minute: 0 }),
      TestUtils.createMockProvider('limited-2', 'anthropic', { requests_per_minute: 0 })
    ]);

    const pool = new LLMPool({ configPath });
    await pool.initialize();

    // All providers should be rate-limited
    const health = pool.getPoolHealth();
    expect(health.availableProviders).toBe(0);

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle network timeouts', async () => {
    const { configPath } = await TestUtils.createTestConfig();
    const pool = new LLMPool({ 
      configPath,
      timeout: 100 // Very short timeout
    });
    await pool.initialize();

    // Mock slow response
    axios.post.mockImplementation(() => 
      new Promise(resolve => setTimeout(resolve, 1000))
    );

    await expect(pool.chat({
      messages: [createTextMessage('user', 'Hello')]
    })).rejects.toThrow();

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle very large messages', async () => {
    const { configPath } = await TestUtils.createTestConfig();
    const pool = new LLMPool({ configPath });
    await pool.initialize();

    TestUtils.mockAxiosResponse(TestUtils.createMockResponse('Response to large message'));

    const largeMessage = 'x'.repeat(100000); // 100K characters
    const response = await pool.chat({
      messages: [createTextMessage('user', largeMessage)]
    });

    expect(response.content).toBe('Response to large message');

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should handle special characters in messages', async () => {
    const { configPath } = await TestUtils.createTestConfig();
    const pool = new LLMPool({ configPath });
    await pool.initialize();

    TestUtils.mockAxiosResponse(TestUtils.createMockResponse('Handled special chars'));

    const specialMessage = '🚀 Hello! @#$%^&*()_+ 中文 العربية 🎉';
    const response = await pool.chat({
      messages: [createTextMessage('user', specialMessage)]
    });

    expect(response.content).toBe('Handled special chars');

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });
});

// Real-world Scenarios
describe('Real-world Scenarios', () => {
  test('should handle provider maintenance windows', async () => {
    const { configPath } = await TestUtils.createTestConfig([
      TestUtils.createMockProvider('primary', 'openai', { priority: 1 }),
      TestUtils.createMockProvider('backup', 'anthropic', { priority: 2 })
    ]);

    const pool = new LLMPool({ configPath, maxRetries: 3 });
    await pool.initialize();

    // Simulate primary provider down for maintenance
    let callCount = 0;
    axios.post.mockImplementation((url) => {
      callCount++;
      if (url.includes('openai')) {
        return Promise.reject(new Error('Service temporarily unavailable'));
      }
      return Promise.resolve(TestUtils.createMockResponse('Backup response', 'anthropic'));
    });

    const response = await pool.chat({
      messages: [createTextMessage('user', 'Hello during maintenance')]
    });

    expect(response.content).toBe('Backup response');
    expect(response.provider).toBe('backup');

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });

  test('should recover from temporary network issues', async () => {
    const { configPath } = await TestUtils.createTestConfig();
    const pool = new LLMPool({ configPath, maxRetries: 3, retryDelay: 100 });
    await pool.initialize();

    // First two attempts fail, third succeeds
    let attemptCount = 0;
    axios.post.mockImplementation(() => {
      attemptCount++;
      if (attemptCount <= 2) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.resolve(TestUtils.createMockResponse('Recovered successfully'));
    });

    const response = await pool.chat({
      messages: [createTextMessage('user', 'Network recovery test')]
    });

    expect(response.content).toBe('Recovered successfully');
    expect(attemptCount).toBe(3);

    await pool.shutdown();
    await TestUtils.cleanupTestConfig(configPath);
  });
});

// Export test utilities for external use
module.exports = {
  TestUtils
};