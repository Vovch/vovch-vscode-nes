import * as vscode from "vscode";

import { OllamaClient } from "~/api/ollama-client.ts";
import { config } from "~/core/config.ts";

const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 60_000;

export class OllamaServer implements vscode.Disposable {
	private consecutiveFailures = 0;
	private lastWarningAt = 0;
	private warned = false;

	getClient(): OllamaClient {
		return new OllamaClient(config.ollamaUrl);
	}

	async ensureReachable(): Promise<boolean> {
		const ok = await this.getClient().ping();
		if (!ok) this.warnUnreachable();
		return ok;
	}

	reportSuccess(): void {
		this.consecutiveFailures = 0;
		this.warned = false;
	}

	reportFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.warnUnreachable();
			this.consecutiveFailures = 0;
		}
	}

	private warnUnreachable(): void {
		const now = Date.now();
		if (this.warned && now - this.lastWarningAt < FAILURE_COOLDOWN_MS) return;
		this.warned = true;
		this.lastWarningAt = now;
		vscode.window.showWarningMessage(
			`Sweep: Ollama is not reachable at ${config.ollamaUrl}. ` +
				"Start Ollama and pull the sweep model: " +
				"`ollama pull hf.co/sweepai/sweep-next-edit-1.5b`.",
		);
	}

	dispose(): void {}
}
