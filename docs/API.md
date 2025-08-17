 
# API Documentation

## Classes

### LLMPool

Main class for managing multiple LLM providers.

#### Constructor

```javascript
new LLMPool(options)
```

**Parameters:**
- `options.configPath` (string) - Path to local configuration file
- `options.configUrl` (string) - URL to remote configuration
- `options.timeout` (number) - Default request timeout in milliseconds
- `options.maxRetries` (number) - Maximum retry attempts
- `options.retryDelay` (number) - Initial retry delay in milliseconds
- `options.useTokenCounting` (boolean) - Enable token estimation

#### Methods

##### initialize()
```javascript
await pool.initialize()
```
Initializes the pool and loads configuration.

##### chat(request)
```javascript
const response = await pool.chat({
  messages: [createTextMessage('user', 'Hello')],
  temperature: 0.7,
  max_tokens: 1000
})
```

**Returns:** ChatResponse object with content, usage, and provider information.

##### getProviderStats()
```javascript
const stats = pool.getProviderStats()
```

**Returns:** Object containing detailed statistics for each provider.

##### getPoolHealth()
```javascript
const health = pool.getPoolHealth()
```

**Returns:** Overall pool health information.

##### shutdown()
```javascript
await pool.shutdown()
```
Gracefully shuts down the pool.

### Provider

Represents a single LLM provider.

#### Properties
- `name` - Provider name
- `type` - Provider type (openai, anthropic, etc.)
- `priority` - Selection priority
- `requestsPerMinute` - Rate limit per minute
- `canUse()` - Returns true if provider is available

### Helper Functions

#### createTextMessage(role, content)
Creates a text message for chat requests.

#### createImageMessage(role, text, imageUrl)
Creates a message with both text and image content.

## Events

The LLMPool class emits the following events:

- `ready` - Emitted when pool is initialized
- `providersUpdated` - Emitted when provider configuration changes
- `requestSuccess` - Emitted on successful requests
- `requestError` - Emitted on request failures
- `configChanged` - Emitted when configuration is updated
- `error` - Emitted on critical errors
```

## 10. docs/CONFIGURATION.md
```markdown
# Configuration Guide

## Configuration Structure

The configuration file should contain a `providers` array with provider configurations.

## Provider Configuration Options

### Required Fields
- `name` - Unique identifier for the provider
- `type` - Provider type (openai, anthropic, groq, together, cohere)
- `api_key` - API authentication key
- `base_url` - Provider API base URL
- `model` - Model identifier to use

### Optional Fields
- `priority` - Selection priority (default: 1)
- `requests_per_minute` - Rate limit per minute (default: 60)
- `requests_per_day` - Rate limit per day (default: 1000)
- `circuit_breaker_threshold` - Failure threshold (default: 5)
- `circuit_breaker_timeout` - Recovery timeout in ms (default: 60000)
- `max_tokens` - Default max tokens (default: 4096)
- `temperature` - Default temperature (default: 0.7)
- `timeout` - Request timeout in ms (default: 30000)
- `input_token_price` - Cost per 1M input tokens
- `output_token_price` - Cost per 1M output tokens

## Provider Types and Base URLs

### OpenAI
- Type: `openai`
- Base URL: `https://api.openai.com/v1`
- Models: `gpt-4`, `gpt-3.5-turbo`, etc.

### Anthropic
- Type: `anthropic`
- Base URL: `https://api.anthropic.com/v1`
- Models: `claude-3-sonnet-20240229`, etc.

### Groq
- Type: `groq`
- Base URL: `https://api.groq.com/openai/v1`
- Models: `mixtral-8x7b-32768`, etc.

### Together AI
- Type: `together`
- Base URL: `https://api.together.xyz/v1`
- Models: Various open-source models

### Cohere
- Type: `cohere`
- Base URL: `https://api.cohere.ai/v1`
- Models: `command`, `command-light`, etc.

## Environment Variables

Use environment variables for API keys:

```json
{
  "api_key": "${OPENAI_API_KEY}"
}
```

## Remote Configuration

For remote configuration, ensure:
1. URL is accessible via HTTPS
2. Proper CORS headers if needed
3. Valid JSON format
4. Checksum validation enabled
