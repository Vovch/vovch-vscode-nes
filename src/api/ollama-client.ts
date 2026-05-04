// Ollama client. Talks to /api/generate, NOT /v1/completions:
// Ollama's OpenAI-compat layer silently drops `options.num_ctx` and the
// top-level `keep_alive`, so the model loads with the host default
// (often 32k via OLLAMA_CONTEXT_LENGTH) and a 4-minute idle timer
// regardless of what we send. The native /api/generate endpoint honours
// both. Schema mapping mirrors cursortab-proxy's translation layer:
//   max_tokens   → options.num_predict
//   temperature  → options.temperature
//   stop         → options.stop
//   num_ctx      → options.num_ctx
//   keep_alive   → top-level keep_alive
//
// We also surface prompt_eval_count / eval_count from the final response
// so it's easy to confirm a prompt actually fits inside num_ctx.

import * as http from "node:http";
import * as https from "node:https";

export interface OllamaCompletionRequest {
	model: string;
	prompt: string;
	temperature: number;
	maxTokens: number;
	stop: string[];
	numCtx: number;
	keepAlive: string;
	timeoutMs: number;
}

export interface OllamaCompletionResult {
	text: string;
	finishReason: string;
	promptEvalCount?: number;
	evalCount?: number;
}

interface OllamaGenerateResponse {
	response?: string;
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
}

export class OllamaClient {
	constructor(private readonly baseUrl: string) {}

	async complete(
		req: OllamaCompletionRequest,
		signal?: AbortSignal,
	): Promise<OllamaCompletionResult> {
		const options: Record<string, unknown> = {
			temperature: req.temperature,
			num_predict: req.maxTokens,
			stop: req.stop,
		};
		// biome-ignore lint/complexity/useLiteralKeys: tsgo requires bracket notation for index signatures
		if (req.numCtx > 0) options["num_ctx"] = req.numCtx;

		const body: Record<string, unknown> = {
			model: req.model,
			prompt: req.prompt,
			stream: false,
			options,
		};
		// biome-ignore lint/complexity/useLiteralKeys: tsgo requires bracket notation for index signatures
		if (req.keepAlive !== "") body["keep_alive"] = req.keepAlive;

		const payload = JSON.stringify(body);
		const url = new URL("/api/generate", this.baseUrl);
		const transport = url.protocol === "https:" ? https : http;
		const port = url.port || (url.protocol === "https:" ? 443 : 80);

		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			const reqOptions: http.RequestOptions = {
				hostname: url.hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
				timeout: req.timeoutMs,
			};

			const httpReq = transport.request(reqOptions, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk.toString();
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						finish(() =>
							reject(
								new Error(`Ollama request failed (${res.statusCode}): ${data}`),
							),
						);
						return;
					}
					try {
						const parsed = JSON.parse(data) as OllamaGenerateResponse;
						const result: OllamaCompletionResult = {
							text: parsed.response ?? "",
							finishReason: parsed.done_reason ?? "stop",
						};
						if (parsed.prompt_eval_count !== undefined) {
							result.promptEvalCount = parsed.prompt_eval_count;
						}
						if (parsed.eval_count !== undefined) {
							result.evalCount = parsed.eval_count;
						}
						finish(() => resolve(result));
					} catch {
						finish(() => reject(new Error("Failed to parse Ollama response")));
					}
				});
			});

			const onError = (error: Error) => {
				finish(() =>
					reject(new Error(`Ollama request error: ${error.message}`)),
				);
			};

			const onTimeout = () => {
				const err = new Error(
					`Ollama request timed out after ${req.timeoutMs}ms`,
				);
				httpReq.destroy(err);
				finish(() => reject(err));
			};

			const onAbort = () => {
				const abortError = new Error("Request aborted");
				abortError.name = "AbortError";
				httpReq.destroy(abortError);
				finish(() => reject(abortError));
			};

			const cleanup = () => {
				httpReq.off("error", onError);
				httpReq.off("timeout", onTimeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			};

			httpReq.on("error", onError);
			httpReq.on("timeout", onTimeout);
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort);
			}

			httpReq.write(payload);
			httpReq.end();
		});
	}

	async ping(timeoutMs = 1500): Promise<boolean> {
		return new Promise((resolve) => {
			const url = new URL("/api/tags", this.baseUrl);
			const transport = url.protocol === "https:" ? https : http;
			const port = url.port || (url.protocol === "https:" ? 443 : 80);
			const req = transport.get(
				{
					hostname: url.hostname,
					port,
					path: url.pathname,
					timeout: timeoutMs,
				},
				(res) => {
					res.resume();
					resolve(
						res.statusCode !== undefined &&
							res.statusCode >= 200 &&
							res.statusCode < 500,
					);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
		});
	}
}
