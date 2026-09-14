import { ProviderMeter } from "@avtar/agent-core";
import type { ConsumerPublicKey } from "@avtar/agent-core";

export interface OpenChannelInput {
  channelId: bigint;
  consumerPublicKey: ConsumerPublicKey;
  rate: bigint;
  escrow: bigint;
}

/**
 * In-memory registry of the channels this provider is currently metering. Each
 * open channel gets a ProviderMeter that validates the consumer's cumulative
 * EdDSA vouchers (monotonic, in-budget, correctly signed) on every call. The
 * provider never learns the private rate — it only counts units.
 */
export class ChannelRegistry {
  readonly #meters = new Map<string, ProviderMeter>();

  open(input: OpenChannelInput): void {
    const key = input.channelId.toString();
    if (this.#meters.has(key)) return;
    this.#meters.set(
      key,
      new ProviderMeter(input.channelId, input.consumerPublicKey, input.rate, input.escrow),
    );
  }

  get(channelId: string): ProviderMeter | undefined {
    return this.#meters.get(channelId);
  }

  has(channelId: string): boolean {
    return this.#meters.has(channelId);
  }

  close(channelId: string): void {
    this.#meters.delete(channelId);
  }
}
