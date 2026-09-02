import "server-only";
import type { AzureExpenseOcrConfig } from "./config";
import { ExpenseOcrError } from "./errors";

const API_VERSION = "2024-11-30";
const MODEL_ID = "prebuilt-receipt";

export type AzureAnalysisState =
  | { state: "pending"; operationUrl: string }
  | { state: "succeeded"; operationUrl: string; result: AzureAnalyzeResponse };

export interface AzureAnalyzeResponse {
  status?: string;
  error?: { code?: string; message?: string };
  analyzeResult?: {
    documents?: Array<{ fields?: Record<string, AzureDocumentField> }>;
  };
}

export interface AzureDocumentField {
  type?: string;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueCurrency?: { amount?: number; currencyCode?: string };
  content?: string;
  confidence?: number;
}

export interface AzureClientDependencies {
  fetch: typeof fetch;
}

export class AzureDocumentIntelligenceClient {
  constructor(
    private readonly config: AzureExpenseOcrConfig,
    private readonly dependencies: AzureClientDependencies = { fetch }
  ) {}

  async startReceiptAnalysis(bytes: ArrayBuffer, mimeType: string): Promise<AzureAnalysisState> {
    const url = new URL(
      `${this.config.endpoint.pathname}/documentintelligence/documentModels/${MODEL_ID}:analyze`,
      this.config.endpoint.origin
    );
    url.searchParams.set("api-version", API_VERSION);
    const response = await this.request(url, {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "Ocp-Apim-Subscription-Key": this.config.apiKey,
      },
      body: bytes,
    });
    if (response.status !== 202) throw await this.providerHttpError(response);

    const operationUrl = response.headers.get("operation-location");
    if (!operationUrl) {
      throw new ExpenseOcrError("INVALID_PROVIDER_RESPONSE", "Azure no entregó la ubicación de la operación.", false);
    }
    this.validateOperationUrl(operationUrl);
    return { state: "pending", operationUrl };
  }

  async pollReceiptAnalysis(operationUrl: string): Promise<AzureAnalysisState> {
    this.validateOperationUrl(operationUrl);
    const response = await this.request(new URL(operationUrl), {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": this.config.apiKey },
    });
    if (!response.ok) throw await this.providerHttpError(response);

    let payload: AzureAnalyzeResponse;
    try {
      payload = (await response.json()) as AzureAnalyzeResponse;
    } catch (cause) {
      throw new ExpenseOcrError("INVALID_PROVIDER_RESPONSE", "Azure devolvió una respuesta inválida.", false, { cause });
    }
    const status = payload.status?.toLowerCase();
    if (status === "notstarted" || status === "running") return { state: "pending", operationUrl };
    if (status === "succeeded" && payload.analyzeResult) {
      return { state: "succeeded", operationUrl, result: payload };
    }
    if (status === "failed") {
      const code = payload.error?.code ?? "DocumentAnalysisFailed";
      const retryable = /internal|timeout|temporar|unavailable|rate/i.test(code);
      throw new ExpenseOcrError(
        retryable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED_DOCUMENT",
        retryable ? "Azure no pudo completar temporalmente el análisis." : "Azure rechazó el comprobante para análisis.",
        retryable
      );
    }
    throw new ExpenseOcrError("INVALID_PROVIDER_RESPONSE", "Azure devolvió un estado de operación desconocido.", false);
  }

  private validateOperationUrl(value: string): void {
    let operation: URL;
    try {
      operation = new URL(value);
    } catch {
      throw new ExpenseOcrError("INVALID_PROVIDER_RESPONSE", "Azure entregó una URL de operación inválida.", false);
    }
    if (operation.protocol !== "https:" || operation.origin !== this.config.endpoint.origin || operation.username || operation.password) {
      throw new ExpenseOcrError("INVALID_PROVIDER_RESPONSE", "Azure entregó una URL de operación fuera del origen permitido.", false);
    }
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      return await this.dependencies.fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new ExpenseOcrError("REQUEST_TIMEOUT", "Azure excedió el tiempo máximo de respuesta.", true, { cause });
      }
      throw new ExpenseOcrError("PROVIDER_UNAVAILABLE", "No fue posible contactar a Azure.", true, { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  private async providerHttpError(response: Response): Promise<ExpenseOcrError> {
    if (response.status === 401 || response.status === 403) {
      return new ExpenseOcrError("PROVIDER_AUTH", "Azure rechazó las credenciales configuradas.", false);
    }
    if (response.status === 408 || response.status === 429) {
      return new ExpenseOcrError("PROVIDER_RATE_LIMIT", "Azure solicitó reintentar el análisis más tarde.", true);
    }
    if (response.status >= 500) {
      return new ExpenseOcrError("PROVIDER_UNAVAILABLE", "Azure no está disponible temporalmente.", true);
    }
    return new ExpenseOcrError("PROVIDER_REJECTED_DOCUMENT", "Azure rechazó la solicitud de análisis.", false);
  }
}
