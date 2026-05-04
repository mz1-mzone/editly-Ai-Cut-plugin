/**
 * Editly AI Editor — OpenRouter API Client
 * Base wrapper for OpenRouter API calls using Node.js http module.
 */

var OpenRouterClient = (function () {
  'use strict';

  var https = require('https');

  function OpenRouterClient(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'openrouter.ai';
    this.basePath = '/api/v1';
  }

  /**
   * Make an HTTPS POST request to OpenRouter.
   */
  OpenRouterClient.prototype._request = function (path, body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var postData = JSON.stringify(body);

      var options = {
        hostname: self.baseUrl,
        port: 443,
        path: self.basePath + path,
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + self.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'HTTP-Referer': 'https://editly.studio',
          'X-Title': 'Editly AI Editor'
        }
      };

      var req = https.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          try {
            var parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error('API Error ' + res.statusCode + ': ' + (parsed.error ? (parsed.error.message || JSON.stringify(parsed.error)) : data)));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error('Failed to parse response: ' + data.substring(0, 200)));
          }
        });
      });

      req.on('error', function (e) {
        reject(new Error('Request failed: ' + e.message));
      });

      req.setTimeout(120000, function () {
        req.destroy();
        reject(new Error('Request timed out after 120 seconds'));
      });

      req.write(postData);
      req.end();
    });
  };

  /**
   * Chat completion API call.
   */
  OpenRouterClient.prototype.chatCompletion = function (model, messages, options) {
    var body = {
      model: model,
      messages: messages
    };

    if (options) {
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;
      if (options.response_format) body.response_format = options.response_format;
    }

    return this._request('/chat/completions', body);
  };

  /**
   * Chat completion with audio input (for transcription via multimodal models).
   */
  OpenRouterClient.prototype.audioChat = function (model, audioBase64, audioFormat, prompt) {
    var messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'input_audio',
            input_audio: {
              data: audioBase64,
              format: audioFormat || 'wav'
            }
          }
        ]
      }
    ];

    return this._request('/chat/completions', {
      model: model,
      messages: messages,
      temperature: 0.1
    });
  };

  return OpenRouterClient;
})();

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.OpenRouterClient = OpenRouterClient;
}
