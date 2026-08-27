/**
 * @negotiator/ledger — the append-only, hash-chained audit ledger
 * (PROTOCOL.md §11, ARCHITECTURE S5, FLOW F6). Every service keeps ITS OWN
 * chain in its own database (D023): there is no central ledger service,
 * because a party that must call someone else to record what it did has
 * a failure mode the money path cannot afford, and a central ledger would
 * be a trusted party this architecture deliberately does not have.
 * Divergence between parties is detectable by comparing chains (§9).
 *
 * This package exports NO update and NO delete (CONSTRAINTS #7); its test
 * suite greps every workspace for one.
 */
export {
  ENTRY_TYPES,
  GENESIS_HASH,
  Ledger,
  entryHash,
  migrateLedger,
  type ChainVerdict,
  type EntryType,
  type LedgerEntry,
  type ListOptions,
} from './ledger.js';
