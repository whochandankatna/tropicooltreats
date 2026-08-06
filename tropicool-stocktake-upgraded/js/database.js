/**
 * Backend switch. database.mock.js (in-memory, no network) and
 * database.supabase.js (real Postgres + RLS) export the identical
 * function-for-function API — this module picks whichever one applies
 * based on config.js's SUPABASE_URL and re-exports it, so no calling code
 * in home.js/stocktake.js/items.js/etc. needs to know or care which
 * backend is active. See database.mock.js's and database.supabase.js's own
 * top comments for what each actually does.
 */
import { SUPABASE_URL } from './config.js';

const backend = SUPABASE_URL
  ? await import('./database.supabase.js')
  : await import('./database.mock.js');

export const {
  ValidationError, ConflictError,
  initDatabase, onChange, getAuditLog,
  getStoreInventory, getBatchesFor, addItem, updateStoreInventory,
  addBatch, closeBatch, setItemCritical, archiveItem, getArchivedInventory, unarchiveItem,
  getOrStartSession, getSession, getSessionProgress, submitSession, approveSession, reopenSession,
  getCountLines, saveCountLine, getLastCountLineFor,
  getStaffPublic, verifyStaffPin,
  getReorderList, getExpiryAlerts, getLargestVariances, getStaffCompletion, getWasteReport, getValuationReport,
  getOrders, createDraftOrder, updateOrderLineQty, removeOrderLine, markOrderSent, cancelOrder, receiveOrder,
  getCashCounts, saveCashCount, approveCashCount,
  getAnnouncements, postAnnouncement,
  getRoster,
} = backend;
