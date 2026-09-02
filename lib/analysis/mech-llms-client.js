/**
 * Mech LLMs API Client
 *
 * Simple client for calling Mech LLMs API for insight extraction
 */

export class MechLLMsClient {
  constructor(config) {
    this.mechUrl = config.mechUrl || 'https://llms.mechdna.net';
    this.appId = config.appId;
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;

    if (!this.appId || !this.apiKey) {
      throw new Error('Mech LLMs client requires appId and apiKey');
    }
  }

  /**
   * Complete a prompt
   */
  async complete(options) {
    const {
      model = 'claude-sonnet-4-5',
      prompt,
      max_tokens = 2000,
      temperature = 0.7,
      system = null
    } = options;

    const payload = {
      model,
      prompt,
      max_tokens,
      temperature
    };

    if (system) {
      payload.system = system;
    }

    try {
      const response = await this.fetchImpl(`${this.mechUrl}/api/apps/${this.appId}/complete`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Mech LLMs API error: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      const transportError = new Error('Mech LLMs request failed.');
      transportError.code = 'MECH_LLM_TRANSPORT_FAILED';
      console.error('[MechLLMsClient] Request failed', { code: transportError.code });
      throw transportError;
    }
  }

  /**
   * Stream completion (not implemented yet)
   */
  async stream(options) {
    throw new Error('Streaming not yet implemented');
  }
}
