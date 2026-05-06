/**
 * Editly AI Editor: Gemini Nano Banana Pro Image Generation
 * Uses Gemini 3 Pro Image Preview for AI image editing with reference frames.
 */

var GeminiImage = (function () {
  'use strict';

  var API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

  /**
   * Generate an AI-edited image from a reference frame + text prompt.
   * @param {string} apiKey - Gemini API key
   * @param {string} base64Image - Base64-encoded JPEG of the first frame
   * @param {string} prompt - User's VFX/background change prompt
   * @param {string} model - Model name (default: gemini-3-pro-image-preview)
   * @returns {Promise<{success: boolean, imageBase64?: string, error?: string}>}
   */
  function generate(apiKey, base64Image, prompt, model) {
    model = model || 'gemini-3-pro-image-preview';

    var url = API_BASE + model + ':generateContent?key=' + apiKey;

    var body = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: base64Image
            }
          }
        ]
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    };

    console.log('[Gemini] Generating image with model: ' + model);
    console.log('[Gemini] Prompt: ' + prompt.substring(0, 80) + '...');

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 120000; // 2 min timeout for image generation

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var response = JSON.parse(xhr.responseText);
            var result = parseResponse(response);
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse Gemini response: ' + e.message));
          }
        } else if (xhr.status === 429) {
          console.log('[Gemini] Rate limited, retrying in 5s...');
          setTimeout(function () {
            retryOnce(url, body, resolve, reject);
          }, 5000);
        } else {
          var errMsg = 'Gemini API error ' + xhr.status;
          try {
            var errBody = JSON.parse(xhr.responseText);
            if (errBody.error && errBody.error.message) {
              errMsg += ': ' + errBody.error.message;
            }
          } catch (e) {}
          reject(new Error(errMsg));
        }
      };

      xhr.onerror = function () {
        reject(new Error('Network error calling Gemini API'));
      };

      xhr.ontimeout = function () {
        reject(new Error('Gemini API request timed out (2 min)'));
      };

      xhr.send(JSON.stringify(body));
    });
  }

  /**
   * Parse Gemini response to extract image data.
   */
  function parseResponse(response) {
    if (!response.candidates || !response.candidates[0]) {
      // Check for safety block
      if (response.promptFeedback && response.promptFeedback.blockReason) {
        return { success: false, error: 'Content blocked: ' + response.promptFeedback.blockReason };
      }
      return { success: false, error: 'No response from Gemini' };
    }

    var parts = response.candidates[0].content.parts;
    var textParts = [];
    var imageBase64 = null;

    for (var i = 0; i < parts.length; i++) {
      if (parts[i].text) {
        textParts.push(parts[i].text);
      } else if (parts[i].inlineData && parts[i].inlineData.data) {
        imageBase64 = parts[i].inlineData.data;
      }
    }

    if (!imageBase64) {
      return {
        success: false,
        error: 'Gemini did not return an image. Response: ' + textParts.join(' ')
      };
    }

    console.log('[Gemini] Image generated successfully (' + Math.round(imageBase64.length / 1024) + ' KB)');
    return {
      success: true,
      imageBase64: imageBase64,
      text: textParts.join('\n')
    };
  }

  /**
   * Retry once on rate limit.
   */
  function retryOnce(url, body, resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 120000;

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var response = JSON.parse(xhr.responseText);
          resolve(parseResponse(response));
        } catch (e) {
          reject(new Error('Retry parse failed: ' + e.message));
        }
      } else {
        reject(new Error('Gemini retry failed with status ' + xhr.status));
      }
    };
    xhr.onerror = function () { reject(new Error('Retry network error')); };
    xhr.ontimeout = function () { reject(new Error('Retry timed out')); };
    xhr.send(JSON.stringify(body));
  }

  /**
   * Save base64 image to a local file using Node.js fs.
   * @param {string} base64Data - Base64-encoded image
   * @param {string} outputPath - Where to save the file
   * @returns {boolean} success
   */
  function saveBase64ToFile(base64Data, outputPath) {
    try {
      var fs = require('fs');
      var buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(outputPath, buffer);
      console.log('[Gemini] Saved image to: ' + outputPath);
      return true;
    } catch (e) {
      console.error('[Gemini] Failed to save image: ' + e.message);
      return false;
    }
  }

  /**
   * Load a local image file as base64.
   * @param {string} filePath - Path to image file
   * @returns {string} base64 encoded data
   */
  function loadImageAsBase64(filePath) {
    var fs = require('fs');
    var buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  }

  return {
    generate: generate,
    saveBase64ToFile: saveBase64ToFile,
    loadImageAsBase64: loadImageAsBase64
  };
})();
