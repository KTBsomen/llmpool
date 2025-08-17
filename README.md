 
# LLM Pool Manager

A production-ready, fault-tolerant Node.js library for managing multiple LLM API providers with intelligent load balancing, automatic failover, and dynamic configuration management.

## Features

🚀 **Multi-Provider Support**
- OpenAI GPT models
- Anthropic Claude models  
- Groq models
- Together AI models
- Cohere models
- Easy to extend for new providers

⚖️ **Intelligent Load Balancing**
- Priority-based provider selection
- Success rate tracking
- Response time optimization
- Circuit breaker pattern

🔄 **Automatic Failover**
- Seamless switching between providers
- Configurable retry logic with exponential backoff
- Rate limit detection and handling

📊 **Advanced Rate Limiting**
- Per-minute and per-day request limits
- Dynamic rate limit detection from API responses
- Intelligent request distribution

🛡️ **Fault Tolerance**
- Circuit breaker for failing providers
- Request timeout handling
- Network error recovery
- Provider health monitoring

⚙️ **Dynamic Configuration**
- Hot-reload configuration changes
- Local file or remote URL configuration
- Configuration validation and checksums
- Zero-downtime updates

🖼️ **Multi-Modal Support**
- Text and image message handling
- Base64 image support
- Provider-specific format conversion

📈 **Comprehensive Monitoring**
- Real-time provider statistics
- Cost tracking with token pricing
- Performance metrics
- Health checks and alerts

## Installation

```bash
npm install llmpool
```

## Quick Start

### 1. Create Configuration

Create a `config.json` file:

```json
{
  "providers": [
    {
      "name": "groq-primary",
      "type": "groq",
      "api_key": "your-groq-api-key",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "mixtral-8x7b-32768",
      "priority": 1,
      "requests_per_minute": 30,
      "requests_per_day": 1000
    },
    {
      "name": "openai-fallback",
      "type": "openai", 
      "api_key": "your-openai-api-key",
      "base_url": "https://api.openai.com/v1",
      "model": "gpt-4",
      "priority": 2,
      "requests_per_minute": 100,
      "requests_per_day": 5000
    }
  ]
}
```

### 2. Basic Usage

```javascript
const { LLMPool, createTextMessage } = require('llmpool');

async function main() {
  // Initialize pool
  const pool = new LLMPool({
    configPath: './config.json'
  });

  await pool.initialize();

  // Send chat request
  const response = await pool.chat({
    messages: [
      createTextMessage('system', 'You are a helpful assistant.'),
      createTextMessage('user', 'What is the capital of France?')
    ],
    temperature: 0.7,
    max_tokens: 1000
  });

  console.log('Response:', response.content);
  console.log('Provider:', response.provider);
  console.log('Tokens used:', response.usage.total_tokens);

  await pool.shutdown();
}

main().catch(console.error);
```

## Advanced Usage

### Image Support

```javascript
const { createImageMessage } = require('llmpool');

const response = await pool.chat({
  messages: [
    createImageMessage(
      'user',
      'What do you see in this image?',
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...'
    )
  ]
});
```

### Remote Configuration

```javascript
const pool = new LLMPool({
  configUrl: 'https://your-domain.com/llm-config.json',
  checkInterval: 300000 // Check for updates every 5 minutes
});

pool.on('configChanged', (config) => {
  console.log('Configuration updated automatically');
});
```

### Event Monitoring

```javascript
pool.on('requestSuccess', (event) => {
  console.log(`✅ ${event.provider} succeeded on attempt ${event.attempt}`);
});

pool.on('requestError', (event) => {
  console.log(`❌ ${event.provider} failed: ${event.error}`);
});

pool.on('providersUpdated', (providers) => {
  console.log(`Updated ${providers.length} providers`);
});
```

### Health Monitoring

```javascript
// Get overall pool health
const health = pool.getPoolHealth();
console.log(`Available: ${health.availableProviders}/${health.totalProviders}`);

// Get detailed provider statistics
const stats = pool.getProviderStats();
Object.entries(stats).forEach(([name, stat]) => {
  console.log(`${name}:`);
  console.log(`  Success Rate: ${stat.performance.successRate.toFixed(2)}%`);
  console.log(`  Avg Response Time: ${stat.performance.averageResponseTime}ms`);
  console.log(`  Total Cost: $${stat.usage.totalCost.toFixed(4)}`);
});
```

## Configuration Reference

### Pool Configuration

```javascript
const pool = new LLMPool({
  // Configuration source (choose one)
  configPath: './config.json',           // Local file path
  configUrl: 'https://example.com/config.json', // Remote URL
  
  // Behavior settings
  timeout: 30000,        // Request timeout (ms)
  maxRetries: 3,         // Maximum retry attempts
  retryDelay: 1000,      // Initial retry delay (ms)
  checkInterval: 300000, // Config check interval (ms)
  useTokenCounting: true // Enable token estimation
});
```

### Provider Configuration

```json
{
  "name": "provider-name",          // Unique identifier
  "type": "openai",                 // Provider type
  "api_key": "your-api-key",        // API authentication
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4",                 // Model to use
  "priority": 1,                    // Selection priority (lower = higher priority)
  
  // Rate limiting
  "requests_per_minute": 100,       // RPM limit
  "requests_per_day": 5000,         // Daily limit
  
  // Circuit breaker
  "circuit_breaker_threshold": 5,   // Failure threshold
  "circuit_breaker_timeout": 60000, // Recovery timeout (ms)
  
  // Request defaults
  "max_tokens": 4096,               // Default max tokens
  "temperature": 0.7,               // Default temperature
  "timeout": 30000,                 // Request timeout (ms)
  
  // Cost tracking (optional)
  "input_token_price": 0.03,        // Cost per 1K input tokens
  "output_token_price": 0.06        // Cost per 1K output tokens
}
```

### Supported Provider Types

| Provider | Type | Base URL |
|----------|------|----------|
| OpenAI | `openai` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` |
| Groq | `groq` | `https://api.groq.com/openai/v1` |
| Together AI | `together` | `https://api.together.xyz/v1` |
| Cohere | `cohere` | `https://api.cohere.ai/v1` |

## Error Handling

The library provides specific error types for different scenarios:

```javascript
const { 
  ProviderError, 
  RateLimitError, 
  ConfigurationError 
} = require('llmpool');

try {
  const response = await pool.chat({ messages });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limited by ${error.provider}, retry in ${error.resetTime}s`);
  } else if (error instanceof ProviderError) {
    console.log(`Provider ${error.provider} failed: ${error.message}`);
    if (error.retryable) {
      // Can retry with different provider
    }
  } else if (error instanceof ConfigurationError) {
    console.log(`Configuration issue: ${error.message}`);
  }
}
```

## Testing

Run the test suite:

```bash
npm test
```

Run specific test categories:

```bash
# Unit tests only
npm test -- --testNamePattern="LLMPool|Provider|ConfigManager"

# Integration tests
npm test -- --testNamePattern="Integration"

# Performance tests  
npm test -- --testNamePattern="Performance"
```

## Performance Considerations

### Concurrent Requests

The pool handles concurrent requests efficiently:

```javascript
// Process multiple requests simultaneously
const promises = requests.map(request => 
  pool.chat({ messages: request.messages })
);

const results = await Promise.allSettled(promises);
```

### Memory Usage

- Provider statistics are kept in memory with configurable history limits
- Token counting uses efficient algorithms when enabled
- Configuration changes don't cause memory leaks

### Optimization Tips

1. **Set appropriate priorities** - Put faster/cheaper providers first
2. **Configure realistic rate limits** - Match provider specifications
3. **Use circuit breakers** - Prevent cascading failures
4. **Monitor health regularly** - Detect issues early
5. **Cache configurations** - Reduce remote config fetches

## Security Best Practices

### API Key Management

```javascript
// Use environment variables
const config = {
  providers: [{
    name: 'openai',
    type: 'openai',
    api_key: process.env.OPENAI_API_KEY,
    // ... other config
  }]
};
```

### Request Validation

All requests are validated before sending:

- Message format validation
- Content length checks  
- Parameter sanitization
- Provider capability verification

### Network Security

- HTTPS-only connections
- Request timeout protection
- Retry limit enforcement
- Error message sanitization

## Monitoring and Observability

### Metrics Collection

```javascript
// Set up periodic monitoring
setInterval(() => {
  const health = pool.getPoolHealth();
  const stats = pool.getProviderStats();
  
  // Log metrics to your monitoring system
  console.log('Pool Health:', health);
  
  // Alert on issues
  if (!health.healthy) {
    console.warn('🚨 Pool unhealthy - no available providers');
  }
  
  Object.entries(stats).forEach(([name, stat]) => {
    if (stat.performance.successRate < 90) {
      console.warn(`⚠️ ${name} has low success rate: ${stat.performance.successRate}%`);
    }
  });
}, 30000);
```

### Integration with Monitoring Tools

The library emits structured events that can be integrated with monitoring tools:

```javascript
// Prometheus metrics example
pool.on('requestSuccess', (event) => {
  prometheus.requestsTotal
    .labels({ provider: event.provider, status: 'success' })
    .inc();
});

pool.on('requestError', (event) => {
  prometheus.requestsTotal
    .labels({ provider: event.provider, status: 'error' })
    .inc();
});
```

## Troubleshooting

### Common Issues

**No available providers**
- Check provider configurations
- Verify API keys are valid
- Check rate limits haven't been exceeded
- Ensure network connectivity

**High failure rates**
- Review circuit breaker thresholds
- Check provider status pages
- Verify request formats
- Monitor network timeouts

**Configuration not updating**
- Verify remote URL accessibility
- Check file permissions for local configs
- Review checkInterval setting
- Monitor configChanged events

### Debug Mode

Enable verbose logging:

```javascript
const pool = new LLMPool({
  configPath: './config.json',
  debug: true
});

pool.on('debug', (message) => {
  console.log('DEBUG:', message);
});
```

### Health Checks

Implement regular health checks:

```javascript
async function healthCheck() {
  const health = pool.getPoolHealth();
  
  if (!health.healthy) {
    throw new Error('LLM Pool is unhealthy');
  }
  
  return {
    status: 'healthy',
    providers: health.availableProviders,
    total: health.totalProviders
  };
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

### Development Setup

```bash
git clone https://github.com/KTBsomen/llmpool.git
cd llmpool
npm install
npm test
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Changelog

### v1.0.0
- Initial release
- Multi-provider support
- Dynamic configuration
- Circuit breaker implementation
- Comprehensive test suite
- Production-ready error handling

---

For more examples and advanced usage patterns, see the [examples](./examples) directory.