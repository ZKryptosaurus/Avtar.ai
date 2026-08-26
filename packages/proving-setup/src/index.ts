export const PACKAGE_NAME = "proving-setup";

// Voucher signing + settlement-witness crypto for the Midnight lane:
// bounded-scalar Schnorr-over-Jubjub vouchers, rate/nullifier commitments,
// using the same curve primitives `avtar-escrow.compact` verifies with.
export * from "./midnight.js";
