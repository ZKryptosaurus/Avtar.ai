// @avtar/agent-consumer — LLM-driven consumer agents that buy metered provider
// services per call through the @avtar/agent-core channel and settle once with
// a ZK proof.
//
// ServiceAgent (+ AgentBrain: StubAgentBrain / OpenAiAgentBrain) is the general
// tool-using agent that picks WHICH service to use each turn. WeatherConsumerAgent
// (+ LlmClient) is the original single-service agent, kept for reference.

export * from "./agent.js";
export * from "./stub-agent.js";
export * from "./openai-agent.js";

export * from "./llm.js";
export * from "./openai-client.js";
export * from "./consumer.js";
