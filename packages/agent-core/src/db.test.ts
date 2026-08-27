import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ChannelTerms } from "./channel.js";
import { MeterDb } from "./db.js";
import type { Voucher } from "@avtar/proving-setup";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const terms: ChannelTerms = {
  channelId: 123n,
  rate: 5n,
  rateBlind: 7n,
  escrow: 100n,
  channelSecret: 11n,
  consumerPrivateKey: bytes(1),
  depositorPayload: bytes(2),
  providerPayload: bytes(3),
  tokenPayload: bytes(4),
};

const voucher: Voucher = {
  channelId: 123n,
  totalUnits: 2n,
  message: 456n,
  consumerPublicKey: { x: 17n, y: 19n },
  signature: { sigRx: 23n, sigRy: 29n, sigRemainder: 31n, sigQuotient: 37n, sigS: 41n },
};

test("MeterDb persists channel snapshots and meter events", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-core-db-"));
  const db = new MeterDb(join(dir, "metering.db"));

  try {
    db.saveChannel({
      terms,
      consumerPublicKey: voucher.consumerPublicKey,
      rateCommitment: 13n,
      lastAcceptedUnits: 0n,
      openTx: "mock_open",
      serviceName: "weather",
    });
    db.updateMeter(terms.channelId, 2n, voucher, false, "voucher_accepted");

    assert.deepEqual(db.loadChannels(), [
      {
        terms: {
          ...terms,
          consumerPrivateKey:
            "0101010101010101010101010101010101010101010101010101010101010101",
          depositorPayload:
            "0202020202020202020202020202020202020202020202020202020202020202",
          providerPayload:
            "0303030303030303030303030303030303030303030303030303030303030303",
          tokenPayload:
            "0404040404040404040404040404040404040404040404040404040404040404",
        },
        consumerPublicKey: voucher.consumerPublicKey,
        rateCommitment: 13n,
        lastAcceptedUnits: 2n,
        latestVoucher: voucher,
        halted: false,
        openTx: "mock_open",
        serviceName: "weather",
      },
    ]);
    assert.deepEqual(db.listMeterEvents(terms.channelId), [
      {
        channelId: 123n,
        cumulativeUnits: 2n,
        eventType: "voucher_accepted",
      },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
