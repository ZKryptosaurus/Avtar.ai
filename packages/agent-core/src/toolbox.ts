import type { Service } from "./service.js";

/** A single tool invocation routed through the toolbox. */
export interface ToolCall {
  /** Tool name — must match a key the toolbox was built with. */
  tool: string;
  /** Arguments for the chosen sub-service's request. */
  args: unknown;
}

/** The result of a routed tool call. */
export interface ToolResult {
  tool: string;
  result: unknown;
}

/**
 * A {@link Service} that routes each {@link ToolCall} to a named sub-service, so
 * many distinct services are metered over ONE channel and settle with ONE proof.
 * `price()` defers to the chosen tool's own price, so mixed usage still bills
 * correctly per call.
 *
 * This is what lets an LLM consumer pick *which* service it needs each turn
 * (weather, crypto price, translation, …) while the payment channel stays a
 * single consumer↔provider relationship with one escrow and one settlement.
 */
export class ToolboxService implements Service<ToolCall, ToolResult> {
  readonly name = "toolbox";
  readonly #tools: Map<string, Service<any, any>>;

  constructor(tools: Record<string, Service<any, any>>) {
    this.#tools = new Map(Object.entries(tools));
    if (this.#tools.size === 0) throw new Error("toolbox needs at least one tool");
  }

  /** The tool names this toolbox can route to. */
  toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  #get(tool: string): Service<any, any> {
    const svc = this.#tools.get(tool);
    if (svc === undefined) throw new Error(`unknown tool: ${tool}`);
    return svc;
  }

  price(req: ToolCall): bigint {
    return this.#get(req.tool).price(req.args);
  }

  async handle(req: ToolCall): Promise<ToolResult> {
    const svc = this.#get(req.tool);
    return { tool: req.tool, result: await svc.handle(req.args) };
  }
}
