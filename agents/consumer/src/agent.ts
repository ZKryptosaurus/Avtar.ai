import type { MeteredServiceChannel, ToolCall, ToolResult } from "@avtar/agent-core";
import type { ToolSpec } from "@avtar/agent-provider";

/** What the brain decides each round: some tool calls to make, or a final answer. */
export interface AgentDecision {
  calls?: Array<{ tool: string; args: Record<string, unknown> }>;
  answer?: string;
}

/** The "which tool do I use" brain — an LLM (OpenAiAgentBrain) or a deterministic stub. */
export interface AgentBrain {
  decide(goal: string, tools: ToolSpec[], gathered: ToolResult[]): Promise<AgentDecision>;
}

/** Record of one attempted tool call, for reporting. */
export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  served: boolean;
  result?: unknown;
  reason?: string;
  billable?: string;
  cumulativeUnits?: string;
}

export interface AgentRunResult {
  answer: string;
  calls: CallRecord[];
}

export interface ProviderSettlement {
  providerId: string;
  providerLabel: string;
  tool: string;
  turnCalls: number;
  turnBillable: string;
  sessionCalls: number;
  sessionBillable: string;
}

export interface TurnPayment {
  turnCalls: number;
  turnBillable: string;
  sessionCalls: number;
  sessionBillable: string;
  tokenSymbol: string;
  providers: ProviderSettlement[];
}

/**
 * A tool-using consumer agent. Given a goal, it asks the brain WHICH provider
 * tool(s) to use, buys each through the metered channel (paying per call), feeds
 * the results back, and repeats until the brain produces a final answer.
 *
 * Every tool call meters over the SAME channel, so no matter which mix of
 * services the agent picks, the whole session settles with ONE ZK proof.
 */
export class ServiceAgent {
  constructor(
    private readonly channel: MeteredServiceChannel<ToolCall, ToolResult>,
    private readonly brain: AgentBrain,
    private readonly tools: ToolSpec[],
    private readonly maxRounds = 4,
  ) {}

  async run(goal: string): Promise<AgentRunResult> {
    const gathered: ToolResult[] = [];
    const calls: CallRecord[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const decision = await this.brain.decide(goal, this.tools, gathered);
      if (decision.answer !== undefined) {
        return { answer: decision.answer, calls };
      }

      const toolCalls = decision.calls ?? [];
      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        const out = await this.channel.call({ tool: tc.tool, args: tc.args });
        const record: CallRecord = {
          tool: tc.tool,
          args: tc.args,
          served: out.served,
          reason: out.reason,
        };
        if (out.served && out.result) {
          record.result = out.result.result;
          gathered.push(out.result);
        }
        if (out.billable !== undefined) record.billable = out.billable.toString();
        if (out.cumulativeUnits !== undefined) record.cumulativeUnits = out.cumulativeUnits.toString();
        calls.push(record);

        if (!out.served && out.reason === "ceiling-exceeded") {
          // Escrow exhausted — stop buying and let the brain answer with what we have.
          const final = await this.brain.decide(goal, this.tools, gathered);
          return { answer: final.answer ?? "(escrow exhausted)", calls };
        }
      }
    }

    const final = await this.brain.decide(goal, this.tools, gathered);
    return { answer: final.answer ?? "(no answer)", calls };
  }
}
