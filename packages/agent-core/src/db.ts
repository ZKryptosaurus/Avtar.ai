import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConsumerPublicKey, Voucher } from "@avtar/proving-setup";
import type { AddressPayload, ChannelTerms } from "./channel.js";

export type MeterEventType = "voucher_accepted" | "ceiling_reached";

export interface MeterChannelSnapshot {
  terms: ChannelTerms;
  consumerPublicKey: ConsumerPublicKey;
  lastAcceptedUnits: bigint;
  rateCommitment?: bigint;
  latestVoucher?: Voucher;
  halted?: boolean;
  openTx?: string;
  serviceName?: string;
  openedAt?: string;
}

export interface MeterEvent {
  channelId: bigint;
  cumulativeUnits: bigint;
  eventType: MeterEventType;
}

type ChannelRow = Record<string, string | number | null>;

export class MeterDb {
  readonly #db: DatabaseSync;

  constructor(path = "artifacts/metering.db") {
    if (path === ":memory:") {
      this.#db = new DatabaseSync(path);
    } else {
      const resolved = resolveWorkspacePath(path);
      mkdirSync(dirname(resolved), { recursive: true });
      this.#db = new DatabaseSync(resolved);
    }
    this.#initSchema();
  }

  close(): void {
    this.#db.close();
  }

  saveChannel(snapshot: MeterChannelSnapshot): void {
    const now = new Date().toISOString();
    const openedAt = snapshot.openedAt ?? now;

    this.#db
      .prepare(
        `INSERT INTO channels (
          channel_id, service_name, last_accepted_units, halted, opened_at, updated_at,
          rate, rate_blind, escrow, channel_secret, consumer_private_key,
          depositor_payload, provider_payload, token_payload, consumer_pubkey_x,
          consumer_pubkey_y, rate_commitment, open_tx, latest_voucher_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
        ON CONFLICT(channel_id) DO UPDATE SET
          service_name = excluded.service_name,
          last_accepted_units = excluded.last_accepted_units,
          halted = excluded.halted,
          updated_at = excluded.updated_at,
          rate = excluded.rate,
          rate_blind = excluded.rate_blind,
          escrow = excluded.escrow,
          channel_secret = excluded.channel_secret,
          consumer_private_key = excluded.consumer_private_key,
          depositor_payload = excluded.depositor_payload,
          provider_payload = excluded.provider_payload,
          token_payload = excluded.token_payload,
          consumer_pubkey_x = excluded.consumer_pubkey_x,
          consumer_pubkey_y = excluded.consumer_pubkey_y,
          rate_commitment = excluded.rate_commitment,
          open_tx = excluded.open_tx,
          latest_voucher_json = excluded.latest_voucher_json`,
      )
      .run(
        snapshot.terms.channelId.toString(),
        snapshot.serviceName ?? null,
        snapshot.lastAcceptedUnits.toString(),
        snapshot.halted ? 1 : 0,
        openedAt,
        now,
        snapshot.terms.rate.toString(),
        snapshot.terms.rateBlind.toString(),
        snapshot.terms.escrow.toString(),
        snapshot.terms.channelSecret.toString(),
        payloadToHex(snapshot.terms.consumerPrivateKey),
        payloadToHex(snapshot.terms.depositorPayload),
        payloadToHex(snapshot.terms.providerPayload),
        payloadToHex(snapshot.terms.tokenPayload),
        snapshot.consumerPublicKey.x.toString(),
        snapshot.consumerPublicKey.y.toString(),
        snapshot.rateCommitment?.toString() ?? null,
        snapshot.openTx ?? null,
        snapshot.latestVoucher === undefined ? null : serializeVoucher(snapshot.latestVoucher),
      );
  }

  updateOpenTx(channelId: bigint, openTx: string): void {
    this.#db
      .prepare(`UPDATE channels SET open_tx = ?, updated_at = ? WHERE channel_id = ?`)
      .run(openTx, new Date().toISOString(), channelId.toString());
  }

  updateMeter(
    channelId: bigint,
    lastAcceptedUnits: bigint,
    latestVoucher: Voucher | undefined,
    halted: boolean,
    eventType: MeterEventType = "voucher_accepted",
  ): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE channels
         SET last_accepted_units = ?, latest_voucher_json = ?, halted = ?, updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(
        lastAcceptedUnits.toString(),
        latestVoucher === undefined ? null : serializeVoucher(latestVoucher),
        halted ? 1 : 0,
        now,
        channelId.toString(),
      );

    this.#recordMeterEvent(channelId, lastAcceptedUnits, eventType);
  }

  loadChannels(): MeterChannelSnapshot[] {
    const rows = this.#db
      .prepare(
        `SELECT channel_id, service_name, last_accepted_units, halted,
                rate, rate_blind, escrow, channel_secret, consumer_private_key,
                depositor_payload, provider_payload, token_payload, consumer_pubkey_x,
                consumer_pubkey_y, rate_commitment, open_tx, latest_voucher_json
         FROM channels
         ORDER BY opened_at`,
      )
      .all() as ChannelRow[];

    return rows.map((row) => ({
      terms: {
        channelId: bigintColumn(row, "channel_id"),
        rate: bigintColumn(row, "rate"),
        rateBlind: bigintColumn(row, "rate_blind"),
        escrow: bigintColumn(row, "escrow"),
        channelSecret: bigintColumn(row, "channel_secret"),
        consumerPrivateKey: stringColumn(row, "consumer_private_key"),
        depositorPayload: stringColumn(row, "depositor_payload"),
        providerPayload: stringColumn(row, "provider_payload"),
        tokenPayload: stringColumn(row, "token_payload"),
      },
      consumerPublicKey: {
        x: bigintColumn(row, "consumer_pubkey_x"),
        y: bigintColumn(row, "consumer_pubkey_y"),
      },
      rateCommitment:
        row.rate_commitment === null ? undefined : BigInt(String(row.rate_commitment)),
      lastAcceptedUnits: bigintColumn(row, "last_accepted_units"),
      latestVoucher:
        row.latest_voucher_json === null
          ? undefined
          : parseVoucher(String(row.latest_voucher_json)),
      halted: row.halted === 1,
      openTx: row.open_tx === null ? undefined : String(row.open_tx),
      serviceName: row.service_name === null ? undefined : String(row.service_name),
    }));
  }

  /** Load a single channel snapshot by id — used at settlement to fetch the
   * persisted terms + final voucher and settle from durable state. */
  loadChannel(channelId: bigint): MeterChannelSnapshot | undefined {
    return this.loadChannels().find((c) => c.terms.channelId === channelId);
  }

  listMeterEvents(channelId?: bigint): MeterEvent[] {
    const rows = (
      channelId === undefined
        ? this.#db.prepare(
            `SELECT channel_id, cumulative_units, event_type FROM meter_events ORDER BY id`,
          )
        : this.#db.prepare(
            `SELECT channel_id, cumulative_units, event_type
             FROM meter_events WHERE channel_id = ? ORDER BY id`,
          )
    ).all(...(channelId === undefined ? [] : [channelId.toString()])) as ChannelRow[];

    return rows.map((row) => ({
      channelId: bigintColumn(row, "channel_id"),
      cumulativeUnits: bigintColumn(row, "cumulative_units"),
      eventType: stringColumn(row, "event_type") as MeterEventType,
    }));
  }

  #recordMeterEvent(
    channelId: bigint,
    cumulativeUnits: bigint,
    eventType: MeterEventType,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO meter_events (channel_id, cumulative_units, recorded_at, event_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId.toString(), cumulativeUnits.toString(), new Date().toISOString(), eventType);
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        service_name TEXT,
        last_accepted_units TEXT NOT NULL DEFAULT '0',
        halted INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rate TEXT NOT NULL,
        rate_blind TEXT NOT NULL,
        escrow TEXT NOT NULL,
        channel_secret TEXT NOT NULL,
        consumer_private_key TEXT NOT NULL,
        depositor_payload TEXT NOT NULL,
        provider_payload TEXT NOT NULL,
        token_payload TEXT NOT NULL,
        consumer_pubkey_x TEXT NOT NULL,
        consumer_pubkey_y TEXT NOT NULL,
        rate_commitment TEXT,
        open_tx TEXT,
        latest_voucher_json TEXT
      );

      CREATE TABLE IF NOT EXISTS meter_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        cumulative_units TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        event_type TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_meter_events_channel
        ON meter_events (channel_id);
    `);
  }
}

function resolveWorkspacePath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function payloadToHex(payload: AddressPayload): string {
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload).toString("hex");
  }
  return payload.startsWith("0x") || payload.startsWith("0X") ? payload.slice(2) : payload;
}

function serializeVoucher(voucher: Voucher): string {
  return JSON.stringify({
    channelId: voucher.channelId.toString(),
    totalUnits: voucher.totalUnits.toString(),
    message: voucher.message.toString(),
    consumerPublicKey: {
      x: voucher.consumerPublicKey.x.toString(),
      y: voucher.consumerPublicKey.y.toString(),
    },
    signature: {
      sigRx: voucher.signature.sigRx.toString(),
      sigRy: voucher.signature.sigRy.toString(),
      sigRemainder: voucher.signature.sigRemainder.toString(),
      sigQuotient: voucher.signature.sigQuotient.toString(),
      sigS: voucher.signature.sigS.toString(),
    },
  });
}

function parseVoucher(raw: string): Voucher {
  const parsed = JSON.parse(raw) as {
    channelId: string;
    totalUnits: string;
    message: string;
    consumerPublicKey: { x: string; y: string };
    signature: { sigRx: string; sigRy: string; sigRemainder: string; sigQuotient: string; sigS: string };
  };

  return {
    channelId: BigInt(parsed.channelId),
    totalUnits: BigInt(parsed.totalUnits),
    message: BigInt(parsed.message),
    consumerPublicKey: {
      x: BigInt(parsed.consumerPublicKey.x),
      y: BigInt(parsed.consumerPublicKey.y),
    },
    signature: {
      sigRx: BigInt(parsed.signature.sigRx),
      sigRy: BigInt(parsed.signature.sigRy),
      sigRemainder: BigInt(parsed.signature.sigRemainder),
      sigQuotient: BigInt(parsed.signature.sigQuotient),
      sigS: BigInt(parsed.signature.sigS),
    },
  };
}

function stringColumn(row: ChannelRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`expected ${name} to be a string`);
  }
  return value;
}

function bigintColumn(row: ChannelRow, name: string): bigint {
  return BigInt(stringColumn(row, name));
}
