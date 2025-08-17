 
const { 
  LLMPool, 
  createTextMessage, 
  createImageMessage, 
  PROVIDERS 
} = require('../src/');

// Example configuration file (config.json)
const exampleConfig = {
  "providers": [
    {
      "name": "groq-primary",
      "type": "groq",
      "api_key": "your-groq-api-key",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "mixtral-8x7b-32768",
      "priority": 1,
      "requests_per_minute": 30,
      "requests_per_day": 1000,
      "circuit_breaker_threshold": 3,
      "circuit_breaker_timeout": 30000,
      "max_tokens": 4096,
      "temperature": 0.7,
      "timeout": 30000,
      "input_token_price": 0.27,
      "output_token_price": 0.27
    },
    {
      "name": "openai-secondary",
      "type": "openai",
      "api_key": "your-openai-api-key",
      "base_url": "https://api.openai.com/v1",
      "model": "gpt-4",
      "priority": 2,
      "requests_per_minute": 100,
      "requests_per_day": 5000,
      "circuit_breaker_threshold": 5,
      "max_tokens": 4096,
      "temperature": 0.7,
      "input_token_price": 30.0,
      "output_token_price": 60.0
    },
    {
      "name": "anthropic-fallback",
      "type": "anthropic",
      "api_key": "your-anthropic-api-key",
      "base_url": "https://api.anthropic.com/v1",
      "model": "claude-3-sonnet-20240229",
      "priority": 3,
      "requests_per_minute": 50,
      "requests_per_day": 2000,
      "max_tokens": 4096,
      "temperature": 0.7,
      "input_token_price": 3.0,
      "output_token_price": 15.0
    },
    {
      "name": "together-ai",
      "type": "together",
      "api_key": "your-together-api-key",
      "base_url": "https://api.together.xyz/v1",
      "model": "meta-llama/Llama-2-70b-chat-hf",
      "priority": 4,
      "requests_per_minute": 60,
      "requests_per_day": 3000,
      "max_tokens": 4096,
      "temperature": 0.7,
      "input_token_price": 0.9,
      "output_token_price": 0.9
    }
  ]
};

// Save example config to file
const fs = require('fs').promises;

async function saveExampleConfig() {
  try {
    await fs.writeFile('config.json', JSON.stringify(exampleConfig, null, 2));
    console.log('Example config saved to config.json');
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// Usage Examples
async function basicUsage() {
  // Initialize pool with local config file
  const pool = new LLMPool({
    configPath: './config.json',
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 1000,
    useTokenCounting: true
  });

  // Set up event listeners
  pool.on('ready', () => {
    console.log('LLM Pool is ready');
  });

  pool.on('providersUpdated', (providers) => {
    console.log(`Updated ${providers.length} providers`);
  });

  pool.on('requestSuccess', (event) => {
    console.log(`✅ Request succeeded via ${event.provider} on attempt ${event.attempt}`);
  });

  pool.on('requestError', (event) => {
    console.log(`❌ Request failed via ${event.provider} on attempt ${event.attempt}: ${event.error}`);
  });

  pool.on('error', (error) => {
    console.error('Pool error:', error);
  });

  // Initialize the pool
  await pool.initialize();

  // Simple text chat
  try {
    const response = await pool.chat({
      messages: [
        createTextMessage('system', 'You are a helpful assistant.'),
        createTextMessage('user', 'What is the capital of France?')
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    console.log('Response:', response.content);
    console.log('Provider used:', response.provider);
    console.log('Token usage:', response.usage);
  } catch (error) {
    console.error('Chat failed:', error);
  }

  // Get pool statistics
  console.log('Pool Health:', pool.getPoolHealth());
  console.log('Provider Stats:', pool.getProviderStats());

  // Cleanup
  await pool.shutdown();
}

async function imageUsage() {
  const pool = new LLMPool({
    configPath: './config.json'
  });

  await pool.initialize();

  try {
    // Chat with image (base64 encoded image)
    const imageBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...'; // Your base64 image
    
    const response = await pool.chat({
      messages: [
        createImageMessage(
          'user', 
          'What do you see in this image?', 
          imageBase64
        )
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    console.log('Image analysis:', response.content);
  } catch (error) {
    console.error('Image chat failed:', error);
  }

  await pool.shutdown();
}

async function remoteConfigUsage() {
  // Use remote configuration
  const pool = new LLMPool({
    configUrl: 'https://your-domain.com/llm-config.json',
    checkInterval: 300000, // Check for updates every 5 minutes
    maxRetries: 5
  });

  pool.on('configChanged', (config) => {
    console.log('Configuration updated:', config);
  });

  await pool.initialize();

  // Your chat logic here...
  
  await pool.shutdown();
}

async function advancedUsage() {
  const pool = new LLMPool({
    configPath: './config.json',
    timeout: 45000,
    maxRetries: 5,
    retryDelay: 2000
  });

  await pool.initialize();

  // Multi-turn conversation
  const conversation = [
    createTextMessage('system', 'You are a coding assistant.'),
    createTextMessage('user', 'Write a Python function to calculate fibonacci numbers'),
  ];

  try {
    const response1 = await pool.chat({
      messages: conversation,
      temperature: 0.2,
      max_tokens: 1000
    });

    console.log('Assistant:', response1.content);
    conversation.push(createTextMessage('assistant', response1.content));
    conversation.push(createTextMessage('user', 'Now optimize it for better performance'));

    const response2 = await pool.chat({
      messages: conversation,
      temperature: 0.2,
      max_tokens: 1000
    });

    console.log('Optimized version:', response2.content);

    // Print detailed statistics
    const stats = pool.getProviderStats();
    Object.entries(stats).forEach(([name, stat]) => {
      console.log(`\n${name}:`);
      console.log(`  Success Rate: ${stat.performance.successRate.toFixed(2)}%`);
      console.log(`  Avg Response Time: ${stat.performance.averageResponseTime.toFixed(2)}ms`);
      console.log(`  Total Requests: ${stat.usage.totalRequests}`);
      console.log(`  Total Cost: ${stat.usage.totalCost.toFixed(4)}`);
      console.log(`  Tokens Used: ${stat.usage.totalTokensUsed}`);
      console.log(`  Requests Remaining: ${stat.usage.requestsRemaining}/min`);
    });

  } catch (error) {
    console.error('Conversation failed:', error);
  }

  await pool.shutdown();
}

// Error handling and resilience example
async function resilientUsage() {
  const pool = new LLMPool({
    configPath: './config.json',
    maxRetries: 10, // High retry count for resilience
    retryDelay: 1500
  });

  // Comprehensive error handling
  pool.on('requestError', (event) => {
    console.warn(`Retry ${event.attempt} failed for ${event.provider}: ${event.error}`);
  });

  pool.on('requestSuccess', (event) => {
    if (event.attempt > 1) {
      console.log(`✅ Recovered after ${event.attempt} attempts using ${event.provider}`);
    }
  });

  await pool.initialize();

  // Simulate high-load scenario
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      pool.chat({
        messages: [
          createTextMessage('user', `Request ${i}: Tell me a short fact about space.`)
        ],
        temperature: 0.8,
        max_tokens: 100
      }).catch(error => {
        console.error(`Request ${i} failed:`, error.message);
        return null;
      })
    );
  }

  const results = await Promise.allSettled(promises);
  const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
  
  console.log(`Successfully completed ${successful}/${promises.length} requests`);
  console.log('Final pool health:', pool.getPoolHealth());

  await pool.shutdown();
}

// Monitoring and health checks
async function monitoringExample() {
  const pool = new LLMPool({
    configPath: './config.json'
  });

  await pool.initialize();

  // Set up periodic health monitoring
  const healthCheck = setInterval(() => {
    const health = pool.getPoolHealth();
    console.log(`\n📊 Pool Health Check:`);
    console.log(`Available Providers: ${health.availableProviders}/${health.totalProviders}`);
    console.log(`Overall Health: ${health.healthy ? '🟢 Healthy' : '🔴 Unhealthy'}`);

    if (!health.healthy) {
      console.warn('⚠️  Pool is unhealthy! All providers may be rate-limited or failing.');
    }

    // Log provider-specific issues
    Object.entries(health.providers).forEach(([name, stats]) => {
      if (stats.performance.circuitBreakerOpen) {
        console.warn(`🚨 ${name}: Circuit breaker is OPEN`);
      }
      if (stats.performance.successRate < 90) {
        console.warn(`⚠️  ${name}: Low success rate (${stats.performance.successRate.toFixed(1)}%)`);
      }
      if (stats.usage.requestsRemaining < 5) {
        console.warn(`⏰ ${name}: Low rate limit remaining (${stats.usage.requestsRemaining})`);
      }
    });
  }, 30000); // Check every 30 seconds

  // Run for 5 minutes then cleanup
  setTimeout(async () => {
    clearInterval(healthCheck);
    await pool.shutdown();
    console.log('Monitoring stopped');
  }, 300000);
}

// Configuration validation example
async function validateConfiguration() {
  try {
    const { ConfigManager } = require('../src/llm-pool');
    
    const configManager = new ConfigManager({
      configPath: './config.json'
    });

    const config = await configManager.loadConfig();
    console.log('✅ Configuration is valid');
    console.log(`Found ${config.providers.length} providers`);

    // Test each provider configuration
    config.providers.forEach((providerConfig, index) => {
      console.log(`Provider ${index + 1}: ${providerConfig.name} (${providerConfig.type})`);
      
      // Validate required fields
      const required = ['name', 'type', 'api_key', 'base_url', 'model'];
      const missing = required.filter(field => !providerConfig[field]);
      
      if (missing.length > 0) {
        console.error(`❌ Missing required fields: ${missing.join(', ')}`);
      } else {
        console.log('✅ All required fields present');
      }
    });

  } catch (error) {
    console.error('❌ Configuration validation failed:', error.message);
  }
}

// Export functions for testing
module.exports = {
  exampleConfig,
  saveExampleConfig,
  basicUsage,
  imageUsage,
  remoteConfigUsage,
  advancedUsage,
  resilientUsage,
  monitoringExample,
  validateConfiguration
};

// Run examples if this file is executed directly
if (require.main === module) {
  async function runExamples() {
    console.log('🚀 LLM Pool Examples\n');
    
    // Save example configuration
    await saveExampleConfig();
    
    console.log('1. Basic Usage Example:');
    await basicUsage();
    
    console.log('\n2. Configuration Validation:');
    await validateConfiguration();
    
    // Uncomment to run other examples
    // console.log('\n3. Advanced Usage Example:');
    // await advancedUsage();
    
    // console.log('\n4. Resilient Usage Example:');
    // await resilientUsage();
    
    // console.log('\n5. Monitoring Example:');
    // await monitoringExample();
  }
  
  runExamples().catch(console.error);
}