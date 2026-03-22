import type { Mem0Config } from './mem0.schemas.js';

interface OllamaModelDescriptor {
  name?: string;
  model?: string;
}

interface OllamaTagsResponse {
  models?: OllamaModelDescriptor[];
}

interface OllamaModernEmbedResponse {
  embeddings?: number[][];
}

interface OllamaLegacyEmbedResponse {
  embedding?: number[];
}

interface OllamaHealthStatus {
  ok: boolean;
  modelAvailable: boolean;
  details?: string;
}

export class OllamaEmbedder {
  private readonly baseUrl: string;

  constructor(
    private readonly config: Pick<Mem0Config, 'ollamaBaseUrl' | 'embedModel'>,
  ) {
    this.baseUrl = config.ollamaBaseUrl.replace(/\/+$/, '');
  }

  async healthCheck(): Promise<OllamaHealthStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);

      if (!response.ok) {
        return {
          ok: false,
          modelAvailable: false,
          details: `Ollama /api/tags returned ${response.status}`,
        };
      }

      const payload = (await response.json()) as OllamaTagsResponse;
      const modelAvailable = (payload.models ?? []).some(
        (model) =>
          model.name === this.config.embedModel ||
          model.model === this.config.embedModel,
      );

      return {
        ok: modelAvailable,
        modelAvailable,
        details: modelAvailable
          ? undefined
          : `Embedding model ${this.config.embedModel} is not available in Ollama`,
      };
    } catch (error) {
      return {
        ok: false,
        modelAvailable: false,
        details: getErrorMessage(error),
      };
    }
  }

  async embedText(text: string): Promise<number[]> {
    const modernEmbedding = await this.tryModernEndpoint(text);

    if (modernEmbedding !== null) {
      return modernEmbedding;
    }

    return this.tryLegacyEndpoint(text);
  }

  private async tryModernEndpoint(text: string): Promise<number[] | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.embedModel,
          input: text,
        }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as OllamaModernEmbedResponse;

      if (
        !Array.isArray(payload.embeddings) ||
        payload.embeddings.length === 0 ||
        !Array.isArray(payload.embeddings[0])
      ) {
        return null;
      }

      return ensureNumericVector(payload.embeddings[0]);
    } catch {
      return null;
    }
  }

  private async tryLegacyEndpoint(text: string): Promise<number[]> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.embedModel,
          prompt: text,
        }),
      });
    } catch (error) {
      throw new Error(
        `Unable to reach Ollama at ${this.baseUrl}: ${getErrorMessage(error)}`,
      );
    }

    if (!response.ok) {
      const body = await safeReadText(response);

      throw new Error(
        `Ollama embedding request failed (${response.status}): ${
          body || response.statusText
        }`,
      );
    }

    const payload = (await response.json()) as OllamaLegacyEmbedResponse;

    if (!Array.isArray(payload.embedding)) {
      throw new Error('Ollama /api/embeddings returned no embedding vector');
    }

    return ensureNumericVector(payload.embedding);
  }
}

function ensureNumericVector(values: unknown[]): number[] {
  const vector = values.map((value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error('Embedding vector contains a non-numeric value');
    }

    return value;
  });

  if (vector.length === 0) {
    throw new Error('Embedding vector is empty');
  }

  return vector;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
