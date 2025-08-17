const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const { encoding_for_model } = require('tiktoken');

// Provider types
const PROVIDERS = {
  GROQ: 'groq',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  COHERE: 'cohere',
  TOGETHER: 'together',
  GEMINI: 'gemini'
};

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  cohere: 'https://api.cohere.ai/v1'
};

// Message types
const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE_URL: 'image_url'
};

// Token pricing per 1M tokens (input/output)
const TOKEN_PRICING = {
  'gpt-4': { input: 30, output: 60 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'gemini-pro': { input: 0.5, output: 1.5 }
};

// Image token costs (approximate)
const IMAGE_TOKEN_COSTS = {
  'low': 85,    // Low detail
  'high': 170,  // High detail
  'auto': 127   // Average
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

class TokenCounter {
  constructor() {
    this.encoders = new Map();
  }

  getEncoder(model) {
    if (!this.encoders.has(model)) {
      try {
        // Try to get model-specific encoder
        const encoder = encoding_for_model(model);
        this.encoders.set(model, encoder);
        return encoder;
      } catch (error) {
        // Fallback to gpt-3.5-turbo encoder
        if (!this.encoders.has('fallback')) {
          const fallbackEncoder = encoding_for_model('gpt-3.5-turbo');
          this.encoders.set('fallback', fallbackEncoder);
        }
        return this.encoders.get('fallback');
      }
    }
    return this.encoders.get(model);
  }

  countTokensInText(text, model = 'gpt-3.5-turbo') {
    try {
      const encoder = this.getEncoder(model);
      return encoder.encode(text).length;
    } catch (error) {
      console.warn('Token counting failed, using fallback estimation:', error.message);
      // Fallback: roughly 4 characters per token
      return Math.ceil(text.length / 4);
    }
  }

  countTokensInMessages(messages, model = 'gpt-3.5-turbo') {
    let totalTokens = 0;
    const encoder = this.getEncoder(model);
    
    // Base tokens per message (varies by model)
    const baseTokensPerMessage = model.includes('gpt-4') ? 3 : 4;
    const baseTokensPerName = 1;

    for (const message of messages) {
      totalTokens += baseTokensPerMessage;
      
      if (message.name) {
        totalTokens += baseTokensPerName;
        totalTokens += this.countTokensInText(message.name, model);
      }

      if (typeof message.content === 'string') {
        totalTokens += this.countTokensInText(message.content, model);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === MESSAGE_TYPES.TEXT && part.text) {
            totalTokens += this.countTokensInText(part.text, model);
          } else if (part.type === MESSAGE_TYPES.IMAGE_URL) {
            // Add image token cost
            const detail = part.image_url?.detail || 'auto';
            totalTokens += IMAGE_TOKEN_COSTS[detail] || IMAGE_TOKEN_COSTS.auto;
          }
        }
      }
    }

    // Add base tokens for the assistant's reply
    totalTokens += 3;
    
    return totalTokens;
  }

  cleanup() {
    for (const encoder of this.encoders.values()) {
      encoder.free();
    }
    this.encoders.clear();
  }
}

class PersistenceManager {
  constructor(filePath = './llm_pool_stats.json') {
    this.filePath = filePath;
  }

  async saveStats(providers) {
    const stats = {};
    for (const [name, provider] of providers) {
      stats[name] = {
        totalRequests: provider.totalRequests,
        errors: provider.errors,
        totalTokensUsed: provider.totalTokensUsed,
        totalCost: provider.totalCost,
        responseTimeHistory: provider.responseTimeHistory.slice(-50), // Keep last 50
        failureCount: provider.failureCount,
        lastFailure: provider.lastFailure,
        lastUsed: provider.lastUsed,
        successfulRequests: provider.successfulRequests || 0
      };
    }

    try {
      await fs.writeFile(this.filePath, JSON.stringify(stats, null, 2));
    } catch (error) {
      console.warn('Failed to save provider stats:', error.message);
    }
  }

  async loadStats() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      // File doesn't exist or is invalid, return empty stats
      return {};
    }
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
    
    // Usage tracking (will be loaded from persistence)
    this.totalRequests = 0;
    this.successfulRequests = 0;
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
    
    // Token pricing (per 1M tokens)
    this.inputTokenPrice = config.input_token_price || TOKEN_PRICING[this.model]?.input || 0;
    this.outputTokenPrice = config.output_token_price || TOKEN_PRICING[this.model]?.output || 0;
  }
  
  validateConfig(config) {
    const required = ['name', 'type', 'api_key', 'model'];
    for (const field of required) {
      if (!config[field]) {
        throw new ConfigurationError(`Missing required field: ${field}`);
      }
    }
    
    if (!Object.values(PROVIDERS).includes(config.type)) {
      throw new ConfigurationError(`Unsupported provider type: ${config.type}`);
    }
  }

  loadPersistedStats(stats) {
    if (stats) {
      this.totalRequests = stats.totalRequests || 0;
      this.successfulRequests = stats.successfulRequests || 0;
      this.errors = stats.errors || 0;
      this.totalTokensUsed = stats.totalTokensUsed || 0;
      this.totalCost = stats.totalCost || 0;
      this.responseTimeHistory = stats.responseTimeHistory || [];
      this.failureCount = stats.failureCount || 0;
      this.lastFailure = stats.lastFailure ? new Date(stats.lastFailure) : null;
      this.lastUsed = stats.lastUsed ? new Date(stats.lastUsed) : null;
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
      this.failureCount = Math.max(0, this.failureCount - 1);
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
      this.successfulRequests++;
      // Gradually reduce failure count on success
      this.failureCount = Math.max(0, this.failureCount - 0.5);
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
    return (this.successfulRequests / this.totalRequests) * 100;
  }
  
  getReliabilityScore() {
    const successRate = this.getSuccessRate();
    const avgResponseTime = this.getAverageResponseTime();
    const recency = this.lastUsed ? (Date.now() - this.lastUsed.getTime()) / (1000 * 60 * 60) : 24; // Hours since last use
    
    // Higher score is better
    let score = successRate;
    
    // Penalize slow response times
    if (avgResponseTime > 5000) score -= 20;
    else if (avgResponseTime > 2000) score -= 10;
    
    // Penalize circuit breaker being open
    if (this.isCircuitBreakerOpen) score -= 50;
    
    // Slight penalty for not being used recently (prefer proven providers)
    if (recency > 1) score -= Math.min(recency * 2, 20);
    
    return Math.max(0, score);
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
      reliabilityScore: this.getReliabilityScore(),
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
          'User-Agent': 'llmpool/2.0'
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
    this.persistenceManager = new PersistenceManager(options.statsFile);
    this.tokenCounter = new TokenCounter();
    
    this.defaultTimeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.saveStatsInterval = options.saveStatsInterval || 60000; // 1 minute
    
    // Setup config manager
    this.configManager.on('configChanged', (config) => {
      this.updateProviders(config.providers);
    });
    
    this.configManager.on('error', (error) => {
      this.emit('error', error);
    });

    // Auto-save stats periodically
    this.statsInterval = setInterval(() => {
      this.saveStats();
    }, this.saveStatsInterval);
  }
  
  async initialize() {
    // Load persisted stats first
    const persistedStats = await this.persistenceManager.loadStats();
    
    const config = await this.configManager.loadConfig();
    this.updateProviders(config.providers, persistedStats);
    this.configManager.startWatching();
    this.emit('ready');
  }
  
  updateProviders(providerConfigs, persistedStats = {}) {
    const newProviders = new Map();
    
    for (const config of providerConfigs) {
      const provider = new Provider(config);
      
      // Load persisted stats for this provider
      const stats = persistedStats[provider.name];
      if (stats) {
        provider.loadPersistedStats(stats);
      }
      
      // Preserve runtime stats from existing provider if it exists
      const existing = this.providers.get(provider.name);
      if (existing) {
        provider.requestCount = existing.requestCount;
        provider.dailyRequestCount = existing.dailyRequestCount;
        provider.lastReset = existing.lastReset;
        provider.lastDailyReset = existing.lastDailyReset;
        provider.isCircuitBreakerOpen = existing.isCircuitBreakerOpen;
      }
      
      newProviders.set(provider.name, provider);
    }
    
    this.providers = newProviders;
    this.emit('providersUpdated', Array.from(this.providers.values()));
  }
  
  selectProvider(excludeProviders = []) {
    console.log(`Selecting provider. Total providers: ${this.providers.size}, Excluded: [${excludeProviders.join(', ')}]`);
    
    // First, get providers that can be used and are not excluded
    const availableProviders = Array.from(this.providers.values())
      .filter(p => {
        const canUse = p.canUse();
        const notExcluded = !excludeProviders.includes(p.name);
        console.log(`Provider ${p.name}: canUse=${canUse}, notExcluded=${notExcluded}, circuitOpen=${p.isCircuitBreakerOpen}`);
        return canUse && notExcluded;
      })
      .sort((a, b) => {
        // Sort by priority first (lower number = higher priority)
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        
        // Then by reliability score (higher is better)
        const reliabilityDiff = b.getReliabilityScore() - a.getReliabilityScore();
        if (Math.abs(reliabilityDiff) > 5) {
          return reliabilityDiff;
        }
        
        // Then by average response time (lower is better)
        return a.getAverageResponseTime() - b.getAverageResponseTime();
      });
    
    if (availableProviders.length > 0) {
      console.log(`Selected available provider: ${availableProviders[0].name}`);
      return availableProviders[0];
    }
    
    // If no available providers, try to find any provider not excluded (ignore canUse restrictions)
    const fallbackProviders = Array.from(this.providers.values())
      .filter(p => !excludeProviders.includes(p.name))
      .sort((a, b) => {
        // Prefer providers that haven't failed recently
        if (!a.lastFailure && b.lastFailure) return -1;
        if (a.lastFailure && !b.lastFailure) return 1;
        if (!a.lastFailure && !b.lastFailure) return a.priority - b.priority;
        
        // Both have failures, prefer the one with older failure
        return a.lastFailure.getTime() - b.lastFailure.getTime();
      });
    
    if (fallbackProviders.length > 0) {
      console.log(`Selected fallback provider: ${fallbackProviders[0].name} (ignoring canUse restrictions)`);
      return fallbackProviders[0];
    }
    
    console.log('No providers available');
    return null;
  }
  
  estimateTokens(messages, model = 'gpt-3.5-turbo') {
    return this.tokenCounter.countTokensInMessages(messages, model);
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
      'User-Agent': 'llmpool/2.0'
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
        return `${provider.baseURL ?? ENDPOINTS[provider.type]}/chat/completions`;
        
      case PROVIDERS.ANTHROPIC:
        return `${provider.baseURL ?? ENDPOINTS[provider.type]}/messages`;
        
      case PROVIDERS.COHERE:
        return `${provider.baseURL ?? ENDPOINTS[provider.type]}/chat`;
        
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
          prompt_tokens: this.tokenCounter.countTokensInText('prompt estimation'),
          completion_tokens: this.tokenCounter.countTokensInText(content),
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
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
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
      
      // Network/timeout errors are usually retryable
      const retryable = error.code === 'ECONNABORTED' || 
                       error.code === 'ECONNRESET' || 
                       error.code === 'ETIMEDOUT' ||
                       error.response?.status >= 500;
      
      throw new ProviderError(
        `Network error: ${error.message}`,
        provider.name,
        error.response?.status || 0,
        retryable
      );
    }
  }
  
  async chat(request) {
    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error('Messages array is required');
    }
    
    const excludeProviders = [];
    const errors = [];
    let totalAttempts = 0;
    const maxTotalAttempts = this.maxRetries * this.providers.size; // Allow trying all providers multiple times
    
    while (totalAttempts < maxTotalAttempts) {
      const provider = this.selectProvider(excludeProviders);
      
      if (!provider) {
        // If no providers available, reset exclusions and try again with fresh providers
        if (excludeProviders.length > 0) {
          console.log('No available providers, resetting exclusions and trying again...');
          excludeProviders.length = 0; // Clear exclusions
          
          // Wait a bit before retrying all providers
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          continue;
        }
        
        // No providers at all
        const errorMsg = `No providers available after ${totalAttempts + 1} attempts. Errors: ${errors.map(e => `${e.provider}: ${e.message}`).join('; ')}`;
        const error = new Error(errorMsg);
        error.attempts = totalAttempts + 1;
        error.errors = errors;
        throw error;
      }
      
      totalAttempts++;
      
      try {
        console.log(`Attempt ${totalAttempts}: Trying provider ${provider.name}`);
        const result = await this.makeRequest(provider, request);
        
        this.emit('requestSuccess', {
          provider: provider.name,
          attempt: totalAttempts,
          result,
          excludedProviders: [...excludeProviders],
          totalErrors: errors.length
        });
        
        return result;
        
      } catch (error) {
        console.log(`Provider ${provider.name} failed: ${error.message}`);
        
        errors.push({
          provider: provider.name,
          message: error.message,
          attempt: totalAttempts,
          retryable: error.retryable !== false,
          statusCode: error.statusCode || 0
        });
        
        this.emit('requestError', {
          provider: provider.name,
          attempt: totalAttempts,
          error: error.message,
          retryable: error.retryable !== false,
          excludedProviders: [...excludeProviders]
        });
        
        // Always exclude the failed provider for this request cycle
        if (!excludeProviders.includes(provider.name)) {
          excludeProviders.push(provider.name);
        }
        
        // Handle different error types
        if (error instanceof RateLimitError) {
          console.log(`Rate limit hit for ${provider.name}, trying next provider...`);
          // Continue immediately to next provider
          continue;
        }
        
        if (error instanceof ProviderError) {
          if (error.retryable) {
            console.log(`Retryable error from ${provider.name}, trying next provider...`);
            // Add small delay before trying next provider
            await new Promise(resolve => setTimeout(resolve, Math.min(this.retryDelay, 1000)));
            continue;
          } else {
            console.log(`Non-retryable error from ${provider.name}: ${error.message}`);
            // For non-retryable errors, still try other providers
            continue;
          }
        }
        
        // For any other error type, try next provider
        console.log(`Unknown error type from ${provider.name}, trying next provider...`);
        continue;
      }
    }
    
    // All attempts exhausted
    const finalError = new Error(
      `All ${totalAttempts} attempts failed across ${this.providers.size} providers. ` +
      `Errors: ${errors.map(e => `${e.provider}: ${e.message}`).join('; ')}`
    );
    finalError.attempts = totalAttempts;
    finalError.errors = errors;
    finalError.providersAttempted = [...new Set(errors.map(e => e.provider))];
    throw finalError;
  }
  
  async saveStats() {
    try {
      await this.persistenceManager.saveStats(this.providers);
    } catch (error) {
      this.emit('error', new Error(`Failed to save stats: ${error.message}`));
    }
  }
  
  getProviderStats() {
    const stats = {};
    
    for (const [name, provider] of this.providers) {
      stats[name] = {
        type: provider.type,
        model: provider.model,
        priority: provider.priority,
        health: provider.getHealth(),
        usage: {
          totalRequests: provider.totalRequests,
          successfulRequests: provider.successfulRequests,
          errors: provider.errors,
          totalTokensUsed: provider.totalTokensUsed,
          totalCost: provider.totalCost,
          requestsRemaining: Math.max(0, provider.requestsPerMinute - provider.requestCount),
          dailyRequestsRemaining: Math.max(0, provider.requestsPerDay - provider.dailyRequestCount)
        },
        performance: {
          successRate: provider.getSuccessRate(),
          reliabilityScore: provider.getReliabilityScore(),
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
      providers: this.getProviderStats(),
      bestProvider: availableProviders.length > 0 ? this.selectProvider().name : null
    };
  }
  
  // Get detailed analytics
  getAnalytics(timeRange = '24h') {
    const providers = Array.from(this.providers.values());
    const now = new Date();
    let cutoffTime;
    
    switch (timeRange) {
      case '1h':
        cutoffTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '24h':
        cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
    
    const analytics = {
      timeRange,
      totalRequests: 0,
      totalSuccessful: 0,
      totalErrors: 0,
      totalTokens: 0,
      totalCost: 0,
      averageResponseTime: 0,
      providerBreakdown: {}
    };
    
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    
    for (const provider of providers) {
      analytics.totalRequests += provider.totalRequests;
      analytics.totalSuccessful += provider.successfulRequests;
      analytics.totalErrors += provider.errors;
      analytics.totalTokens += provider.totalTokensUsed;
      analytics.totalCost += provider.totalCost;
      
      if (provider.responseTimeHistory.length > 0) {
        const avgTime = provider.getAverageResponseTime();
        totalResponseTime += avgTime * provider.responseTimeHistory.length;
        responseTimeCount += provider.responseTimeHistory.length;
      }
      
      analytics.providerBreakdown[provider.name] = {
        requests: provider.totalRequests,
        successful: provider.successfulRequests,
        errors: provider.errors,
        successRate: provider.getSuccessRate(),
        tokens: provider.totalTokensUsed,
        cost: provider.totalCost,
        avgResponseTime: provider.getAverageResponseTime(),
        lastUsed: provider.lastUsed
      };
    }
    
    analytics.averageResponseTime = responseTimeCount > 0 ? 
      totalResponseTime / responseTimeCount : 0;
    
    analytics.overallSuccessRate = analytics.totalRequests > 0 ? 
      (analytics.totalSuccessful / analytics.totalRequests) * 100 : 0;
    
    return analytics;
  }
  
  // Force reset circuit breakers
  resetCircuitBreakers() {
    for (const provider of this.providers.values()) {
      provider.isCircuitBreakerOpen = false;
      provider.failureCount = 0;
    }
    this.emit('circuitBreakersReset');
  }
  
  // Debug method to see provider states
  debugProviderStates() {
    console.log('\n=== Provider Debug Info ===');
    for (const [name, provider] of this.providers) {
      console.log(`Provider: ${name}`);
      console.log(`  Type: ${provider.type}`);
      console.log(`  Priority: ${provider.priority}`);
      console.log(`  Can Use: ${provider.canUse()}`);
      console.log(`  Circuit Breaker Open: ${provider.isCircuitBreakerOpen}`);
      console.log(`  Failure Count: ${provider.failureCount}`);
      console.log(`  Requests This Minute: ${provider.requestCount}/${provider.requestsPerMinute}`);
      console.log(`  Daily Requests: ${provider.dailyRequestCount}/${provider.requestsPerDay}`);
      console.log(`  Total Requests: ${provider.totalRequests}`);
      console.log(`  Success Rate: ${provider.getSuccessRate().toFixed(2)}%`);
      console.log(`  Reliability Score: ${provider.getReliabilityScore().toFixed(2)}`);
      console.log(`  Last Used: ${provider.lastUsed || 'Never'}`);
      console.log(`  Last Failure: ${provider.lastFailure || 'None'}`);
      console.log(`  Avg Response Time: ${provider.getAverageResponseTime().toFixed(0)}ms`);
      console.log('');
    }
    console.log('=== End Provider Debug ===\n');
  }
  
  // Manually adjust provider priority
  setProviderPriority(providerName, priority) {
    const provider = this.providers.get(providerName);
    if (provider) {
      provider.priority = priority;
      this.emit('providerPriorityChanged', { provider: providerName, priority });
    }
  }
  
  async shutdown() {
    // Save final stats
    await this.saveStats();
    
    // Clear intervals
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    // Stop config watching
    this.configManager.stopWatching();
    
    // Cleanup token counter
    this.tokenCounter.cleanup();
    
    this.emit('shutdown');
  }
}

// Helper function to create a simple text message
function createTextMessage(role, content) {
  return { role, content };
}

// Helper function to create a message with image
function createImageMessage(role, text, imageUrl, detail = 'auto') {
  return {
    role,
    content: [
      { type: MESSAGE_TYPES.TEXT, text },
      { 
        type: MESSAGE_TYPES.IMAGE_URL, 
        image_url: { 
          url: imageUrl,
          detail: detail
        } 
      }
    ]
  };
}

// Helper function to create mixed content message
function createMixedMessage(role, parts) {
  return {
    role,
    content: parts
  };
}

module.exports = {
  LLMPool,
  ConfigManager,
  Provider,
  PersistenceManager,
  TokenCounter,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  PROVIDERS,
  MESSAGE_TYPES,
  TOKEN_PRICING,
  IMAGE_TOKEN_COSTS,
  createTextMessage,
  createImageMessage,
  createMixedMessage
};