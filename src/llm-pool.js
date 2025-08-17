 
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const { encode } = require('gpt-tokenizer');

// Provider types
const PROVIDERS = {
  GROQ: 'groq',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  COHERE: 'cohere',
  TOGETHER: 'together',
  GEMINI:'gemini'
};

// Message types
const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE_URL: 'image_url'
};

class ProviderError extends Error {
  constructor(message, provider, statusCode, retryable = true) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class RateLimitError extends Error {
  constructor(message, provider, resetTime) {
    super(message);
    this.name = 'RateLimitError';
    this.provider = provider;
    this.resetTime = resetTime;
  }
}

class Provider {
  constructor(config) {
    this.validateConfig(config);
    
    this.name = config.name;
    this.type = config.type;
    this.apiKey = config.api_key;
    this.baseURL = config.base_url;
    this.model = config.model;
    this.priority = config.priority || 1;
    
    // Rate limiting
    this.requestsPerMinute = config.requests_per_minute || 60;
    this.requestsPerDay = config.requests_per_day || 1000;
    this.requestCount = 0;
    this.dailyRequestCount = 0;
    this.lastReset = new Date();
    this.lastDailyReset = new Date();
    
    // Circuit breaker
    this.failureCount = 0;
    this.lastFailure = null;
    this.circuitBreakerThreshold = config.circuit_breaker_threshold || 5;
    this.circuitBreakerTimeout = config.circuit_breaker_timeout || 60000; // 1 minute
    this.isCircuitBreakerOpen = false;
    
    // Usage tracking
    this.totalRequests = 0;
    this.errors = 0;
    this.lastUsed = null;
    this.totalTokensUsed = 0;
    this.totalCost = 0;
    
    // Performance metrics
    this.responseTimeHistory = [];
    this.maxHistorySize = 100;
    
    // Provider-specific settings
    this.maxTokens = config.max_tokens || 4096;
    this.temperature = config.temperature || 0.7;
    this.timeout = config.timeout || 30000;
    
    // Token pricing (tokens per dollar)
    this.inputTokenPrice = config.input_token_price || 0;
    this.outputTokenPrice = config.output_token_price || 0;
  }
  
  validateConfig(config) {
    const required = ['name', 'type', 'api_key', 'base_url', 'model'];
    for (const field of required) {
      if (!config[field]) {
        throw new ConfigurationError(`Missing required field: ${field}`);
      }
    }
    
    if (!Object.values(PROVIDERS).includes(config.type)) {
      throw new ConfigurationError(`Unsupported provider type: ${config.type}`);
    }
  }
  
  canUse() {
    const now = new Date();
    
    // Check circuit breaker
    if (this.isCircuitBreakerOpen) {
      if (now - this.lastFailure < this.circuitBreakerTimeout) {
        return false;
      }
      // Try to close circuit breaker
      this.isCircuitBreakerOpen = false;
      this.failureCount = 0;
    }
    
    // Reset rate limit counters
    if (now - this.lastReset >= 60000) { // 1 minute
      this.requestCount = 0;
      this.lastReset = now;
    }
    
    if (now - this.lastDailyReset >= 86400000) { // 24 hours
      this.dailyRequestCount = 0;
      this.lastDailyReset = now;
    }
    
    return this.requestCount < this.requestsPerMinute && 
           this.dailyRequestCount < this.requestsPerDay;
  }
  
  recordRequest(success, responseTime, tokens = 0, cost = 0) {
    this.requestCount++;
    this.dailyRequestCount++;
    this.totalRequests++;
    this.lastUsed = new Date();
    this.totalTokensUsed += tokens;
    this.totalCost += cost;
    
    if (responseTime) {
      this.responseTimeHistory.push(responseTime);
      if (this.responseTimeHistory.length > this.maxHistorySize) {
        this.responseTimeHistory.shift();
      }
    }
    
    if (success) {
      this.failureCount = Math.max(0, this.failureCount - 1);
    } else {
      this.errors++;
      this.failureCount++;
      this.lastFailure = new Date();
      
      if (this.failureCount >= this.circuitBreakerThreshold) {
        this.isCircuitBreakerOpen = true;
      }
    }
  }
  
  getAverageResponseTime() {
    if (this.responseTimeHistory.length === 0) return 0;
    return this.responseTimeHistory.reduce((a, b) => a + b, 0) / this.responseTimeHistory.length;
  }
  
  getSuccessRate() {
    if (this.totalRequests === 0) return 100;
    return ((this.totalRequests - this.errors) / this.totalRequests) * 100;
  }
  
  getHealth() {
    return {
      name: this.name,
      type: this.type,
      available: this.canUse(),
      circuitBreakerOpen: this.isCircuitBreakerOpen,
      requestsRemaining: Math.max(0, this.requestsPerMinute - this.requestCount),
      dailyRequestsRemaining: Math.max(0, this.requestsPerDay - this.dailyRequestCount),
      successRate: this.getSuccessRate(),
      averageResponseTime: this.getAverageResponseTime(),
      totalRequests: this.totalRequests,
      errors: this.errors,
      lastUsed: this.lastUsed
    };
  }
}

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.configPath = options.configPath;
    this.configUrl = options.configUrl;
    this.checkInterval = options.checkInterval || 300000; // 5 minutes
    this.currentChecksum = null;
    this.watchInterval = null;
  }
  
  async loadConfig() {
    let configData;
    
    if (this.configUrl) {
      configData = await this.loadRemoteConfig();
    } else if (this.configPath) {
      configData = await this.loadLocalConfig();
    } else {
      throw new ConfigurationError('No config path or URL provided');
    }
    
    const config = this.validateAndParseConfig(configData);
    const checksum = this.calculateChecksum(JSON.stringify(config));
    
    if (checksum !== this.currentChecksum) {
      this.currentChecksum = checksum;
      this.emit('configChanged', config);
    }
    
    return config;
  }
  
  async loadRemoteConfig() {
    try {
      const response = await axios.get(this.configUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'llmpool/1.0'
        }
      });
      return response.data;
    } catch (error) {
      throw new ConfigurationError(`Failed to load remote config: ${error.message}`);
    }
  }
  
  async loadLocalConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      throw new ConfigurationError(`Failed to load local config: ${error.message}`);
    }
  }
  
  validateAndParseConfig(data) {
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (error) {
        throw new ConfigurationError('Invalid JSON configuration');
      }
    }
    
    if (!data.providers || !Array.isArray(data.providers)) {
      throw new ConfigurationError('Configuration must contain a providers array');
    }
    
    // Validate each provider
    data.providers.forEach((provider, index) => {
      try {
        new Provider(provider);
      } catch (error) {
        throw new ConfigurationError(`Provider ${index} is invalid: ${error.message}`);
      }
    });
    
    return data;
  }
  
  calculateChecksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  startWatching() {
    if (this.watchInterval) return;
    
    this.watchInterval = setInterval(async () => {
      try {
        await this.loadConfig();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.checkInterval);
  }
  
  stopWatching() {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }
}

class LLMPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.providers = new Map();
    this.configManager = new ConfigManager(options);
    this.defaultTimeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    
    // Token counting
    this.useTokenCounting = options.useTokenCounting !== false;
    
    // Setup config manager
    this.configManager.on('configChanged', (config) => {
      this.updateProviders(config.providers);
    });
    
    this.configManager.on('error', (error) => {
      this.emit('error', error);
    });
  }
  
  async initialize() {
    const config = await this.configManager.loadConfig();
    this.updateProviders(config.providers);
    this.configManager.startWatching();
    this.emit('ready');
  }
  
  updateProviders(providerConfigs) {
    const newProviders = new Map();
    
    for (const config of providerConfigs) {
      const provider = new Provider(config);
      
      // Preserve stats from existing provider if it exists
      const existing = this.providers.get(provider.name);
      if (existing) {
        provider.totalRequests = existing.totalRequests;
        provider.errors = existing.errors;
        provider.totalTokensUsed = existing.totalTokensUsed;
        provider.totalCost = existing.totalCost;
        provider.responseTimeHistory = existing.responseTimeHistory;
        provider.failureCount = existing.failureCount;
        provider.lastFailure = existing.lastFailure;
        provider.isCircuitBreakerOpen = existing.isCircuitBreakerOpen;
      }
      
      newProviders.set(provider.name, provider);
    }
    
    this.providers = newProviders;
    this.emit('providersUpdated', Array.from(this.providers.values()));
  }
  
  selectProvider(excludeProviders = []) {
    const availableProviders = Array.from(this.providers.values())
      .filter(p => p.canUse() && !excludeProviders.includes(p.name))
      .sort((a, b) => {
        // Sort by priority first
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        
        // Then by success rate
        const successRateDiff = b.getSuccessRate() - a.getSuccessRate();
        if (Math.abs(successRateDiff) > 5) { // 5% threshold
          return successRateDiff;
        }
        
        // Then by average response time
        return a.getAverageResponseTime() - b.getAverageResponseTime();
      });
    
    if (availableProviders.length === 0) {
      // If no providers available, try the least recently used
      const allProviders = Array.from(this.providers.values())
        .filter(p => !excludeProviders.includes(p.name))
        .sort((a, b) => {
          if (!a.lastUsed) return -1;
          if (!b.lastUsed) return 1;
          return a.lastUsed - b.lastUsed;
        });
      
      return allProviders[0] || null;
    }
    
    return availableProviders[0];
  }
  
  estimateTokens(messages, model = 'gpt-3.5-turbo') {
    if (!this.useTokenCounting) return 0;
    
    try {
      let text = '';
      for (const message of messages) {
        if (typeof message.content === 'string') {
          text += message.content + ' ';
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === MESSAGE_TYPES.TEXT) {
              text += part.text + ' ';
            }
          }
        }
      }
      
      return encode(text).length;
    } catch (error) {
      console.warn('Token estimation failed:', error.message);
      return 0;
    }
  }
  
  formatRequestForProvider(provider, request) {
    const baseRequest = {
      model: provider.model,
      temperature: request.temperature || provider.temperature,
      max_tokens: request.max_tokens || provider.maxTokens
    };
    
    switch (provider.type) {
      case PROVIDERS.OPENAI:
      case PROVIDERS.GROQ:
      case PROVIDERS.TOGETHER:
      case PROVIDERS.GEMINI:
        return {
          ...baseRequest,
          messages: request.messages,
          stream: request.stream || false
        };
        
      case PROVIDERS.ANTHROPIC:
        return this.formatAnthropicRequest(baseRequest, request);
        
      case PROVIDERS.COHERE:
        return this.formatCohereRequest(baseRequest, request);
        
      default:
        throw new ProviderError(`Unsupported provider type: ${provider.type}`, provider.name);
    }
  }
  
  formatAnthropicRequest(baseRequest, request) {
    const messages = [];
    let system = '';
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string' ? msg.content : msg.content[0]?.text || '';
      } else {
        let content = msg.content;
        if (Array.isArray(content)) {
          content = content.map(part => {
            if (part.type === MESSAGE_TYPES.IMAGE_URL) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: part.image_url.url.split(',')[1] || part.image_url.url
                }
              };
            }
            return part;
          });
        }
        
        messages.push({
          role: msg.role,
          content
        });
      }
    }
    
    const anthropicRequest = {
      ...baseRequest,
      messages,
      max_tokens: baseRequest.max_tokens
    };
    
    if (system) {
      anthropicRequest.system = system;
    }
    
    return anthropicRequest;
  }
  
  formatCohereRequest(baseRequest, request) {
    const lastMessage = request.messages[request.messages.length - 1];
    const chatHistory = request.messages.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'CHATBOT' : 'USER',
      message: typeof msg.content === 'string' ? msg.content : msg.content[0]?.text || ''
    }));
    
    return {
      model: baseRequest.model,
      message: typeof lastMessage.content === 'string' ? lastMessage.content : lastMessage.content[0]?.text || '',
      chat_history: chatHistory,
      temperature: baseRequest.temperature,
      max_tokens: baseRequest.max_tokens
    };
  }
  
  getRequestHeaders(provider) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'llmpool/1.0'
    };
    
    switch (provider.type) {
      case PROVIDERS.OPENAI:
      case PROVIDERS.GROQ:
      case PROVIDERS.TOGETHER:
      case PROVIDERS.GEMINI:
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
        break;
        
      case PROVIDERS.ANTHROPIC:
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
        
      case PROVIDERS.COHERE:
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
        break;
    }
    
    return headers;
  }
  
  getEndpoint(provider) {
    switch (provider.type) {
      case PROVIDERS.OPENAI:
      case PROVIDERS.GROQ:
      case PROVIDERS.TOGETHER:
      case PROVIDERS.GEMINI:
        return `${provider.baseURL}/chat/completions`;
        
      case PROVIDERS.ANTHROPIC:
        return `${provider.baseURL}/messages`;
        
      case PROVIDERS.COHERE:
        return `${provider.baseURL}/chat`;
        
      default:
        throw new ProviderError(`Unsupported provider type: ${provider.type}`, provider.name);
    }
  }
  
  parseResponse(provider, responseData) {
    let content = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    
    switch (provider.type) {
      case PROVIDERS.OPENAI:
      case PROVIDERS.GROQ:
      case PROVIDERS.GEMINI:
      case PROVIDERS.TOGETHER:
        content = responseData.choices?.[0]?.message?.content || '';
        usage = responseData.usage || usage;
        break;
        
      case PROVIDERS.ANTHROPIC:
        content = responseData.content?.[0]?.text || '';
        usage = {
          prompt_tokens: responseData.usage?.input_tokens || 0,
          completion_tokens: responseData.usage?.output_tokens || 0,
          total_tokens: (responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0)
        };
        break;
        
      case PROVIDERS.COHERE:
        content = responseData.text || '';
        // Cohere doesn't provide token usage, estimate it
        usage = {
          prompt_tokens: this.estimateTokens([{ content: 'prompt' }]),
          completion_tokens: this.estimateTokens([{ content }]),
          total_tokens: 0
        };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        break;
    }
    
    return {
      id: responseData.id || `${provider.name}-${Date.now()}`,
      content,
      model: responseData.model || provider.model,
      usage,
      provider: provider.name,
      created: responseData.created || Math.floor(Date.now() / 1000)
    };
  }
  
  calculateCost(provider, usage) {
    if (!provider.inputTokenPrice || !provider.outputTokenPrice) {
      return 0;
    }
    
    return (usage.prompt_tokens * provider.inputTokenPrice / 1000000) +
           (usage.completion_tokens * provider.outputTokenPrice / 1000000);
  }
  
  async makeRequest(provider, request) {
    const startTime = Date.now();
    
    try {
      const formattedRequest = this.formatRequestForProvider(provider, request);
      const headers = this.getRequestHeaders(provider);
      const endpoint = this.getEndpoint(provider);
      
      const response = await axios.post(endpoint, formattedRequest, {
        headers,
        timeout: provider.timeout,
        validateStatus: (status) => status < 500 // Don't throw on 4xx errors
      });
      
      const responseTime = Date.now() - startTime;
      
      if (response.status === 429) {
        const resetTime = response.headers['x-ratelimit-reset-requests'] || 
                         response.headers['retry-after'] || 
                         60;
        throw new RateLimitError(
          `Rate limit exceeded for ${provider.name}`,
          provider.name,
          resetTime
        );
      }
      
      if (response.status >= 400) {
        const retryable = response.status >= 500 || response.status === 429;
        throw new ProviderError(
          `Request failed with status ${response.status}: ${response.data?.error?.message || response.statusText}`,
          provider.name,
          response.status,
          retryable
        );
      }
      
      const parsedResponse = this.parseResponse(provider, response.data);
      const cost = this.calculateCost(provider, parsedResponse.usage);
      
      provider.recordRequest(true, responseTime, parsedResponse.usage.total_tokens, cost);
      
      return parsedResponse;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      provider.recordRequest(false, responseTime);
      
      if (error instanceof RateLimitError || error instanceof ProviderError) {
        throw error;
      }
      
      throw new ProviderError(
        `Network error: ${error.message}`,
        provider.name,
        0,
        true
      );
    }
  }
  
  async chat(request) {
    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error('Messages array is required');
    }
    
    const excludeProviders = [];
    let lastError = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const provider = this.selectProvider(excludeProviders);
      
      if (!provider) {
        const error = new Error(`No available providers after ${attempt + 1} attempts. Last error: ${lastError?.message || 'Unknown'}`);
        error.lastError = lastError;
        throw error;
      }
      
      try {
        const result = await this.makeRequest(provider, request);
        
        this.emit('requestSuccess', {
          provider: provider.name,
          attempt: attempt + 1,
          result
        });
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        this.emit('requestError', {
          provider: provider.name,
          attempt: attempt + 1,
          error: error.message
        });
        
        if (error instanceof RateLimitError) {
          excludeProviders.push(provider.name);
          continue;
        }
        
        if (error instanceof ProviderError && error.retryable) {
          excludeProviders.push(provider.name);
          
          if (attempt < this.maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, this.retryDelay * (attempt + 1)));
          }
          continue;
        }
        
        // Non-retryable error
        throw error;
      }
    }
    
    throw lastError || new Error('All retry attempts failed');
  }
  
  getProviderStats() {
    const stats = {};
    
    for (const [name, provider] of this.providers) {
      stats[name] = {
        type: provider.type,
        priority: provider.priority,
        health: provider.getHealth(),
        usage: {
          totalRequests: provider.totalRequests,
          errors: provider.errors,
          totalTokensUsed: provider.totalTokensUsed,
          totalCost: provider.totalCost,
          requestsRemaining: Math.max(0, provider.requestsPerMinute - provider.requestCount),
          dailyRequestsRemaining: Math.max(0, provider.requestsPerDay - provider.dailyRequestCount)
        },
        performance: {
          successRate: provider.getSuccessRate(),
          averageResponseTime: provider.getAverageResponseTime(),
          circuitBreakerOpen: provider.isCircuitBreakerOpen
        }
      };
    }
    
    return stats;
  }
  
  getPoolHealth() {
    const providers = Array.from(this.providers.values());
    const availableProviders = providers.filter(p => p.canUse());
    
    return {
      totalProviders: providers.length,
      availableProviders: availableProviders.length,
      healthy: availableProviders.length > 0,
      providers: this.getProviderStats()
    };
  }
  
  async shutdown() {
    this.configManager.stopWatching();
    this.emit('shutdown');
  }
}

// Helper function to create a simple text message
function createTextMessage(role, content) {
  return { role, content };
}

// Helper function to create a message with image
function createImageMessage(role, text, imageUrl) {
  return {
    role,
    content: [
      { type: MESSAGE_TYPES.TEXT, text },
      { type: MESSAGE_TYPES.IMAGE_URL, image_url: { url: imageUrl } }
    ]
  };
}

module.exports = {
  LLMPool,
  ConfigManager,
  Provider,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  PROVIDERS,
  MESSAGE_TYPES,
  createTextMessage,
  createImageMessage
};