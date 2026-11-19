export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  FRAME_ANCESTORS?: string;
  GHL_CLIENT_ID?: string;
  GHL_CLIENT_SECRET?: string;
  GHL_REDIRECT_URI?: string;
  GHL_SSO_SHARED_SECRET?: string;
  SESSION_SECRET?: string;
  ENC_KEY?: string;
  ADMIN_SECRET_SHA256?: string;
  DEV_LOCATION?: string;
  DEV_EMAIL?: string;
  RESEND_API_KEY?: string;   // send-only key, restricted to the sending domain
  MAIL_FROM?: string;        // e.g. "Reports <reports@example.com>"
  PUBLIC_HOSTS?: string;     // comma list of branded addresses that proxy to this app, e.g. reports.example.com
}

/** A rule condition. All present fields must match. */
export interface RuleWhen {
  typeIn?: string[];          // income type (from incomeTypes) is one of
  titleAny?: string[];        // title contains any (case-insensitive)
  payerAny?: string[];        // payer contains any
  originIs?: string;          // origin location id, or "external" (Stripe row with no location tag)
  addressFrom?: { tag?: string; addressAny?: string[] };  // contact tag present OR address contains any
}

export interface Rule {
  when: RuleWhen;
  set: { segment: string; space?: string; type?: string };
  flag?: string;
  own?: boolean;              // confirmed payment from one of the owner's own companies: counted as such, nothing to confirm
}

export interface LocationConfig {
  displayName: string;
  timezone: string;
  viewers: string[];                     // emails allowed to open the report
  segments: string[];                    // display order
  incomeTypes: { any: string[]; type: string }[];
  rules: Rule[];
  fallback: { segment: string; flag?: string };
  ownCompanies?: string[];               // flags payments that may be between the owner's own companies
  spaceAliases?: Record<string, string>; // regex pattern to replacement, applied before an address becomes a space label
  overrides?: Record<string, { segment?: string; space?: string; type?: string; note?: string }>;
  quickbooks?: Partial<{ prefix: string; bank: string; undeposited: string; stripeFees: string; returned: string; fallbackIncome: string; accountsByType: Record<string, string> }>;
  accountant?: { to: string[]; cc?: string[] };
}

export interface PaymentRow {
  id: string;
  location_id: string;
  source: string;
  kind: string;
  status: string;
  occurred_at: number;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  method: string | null;
  payer: string | null;
  contact_id: string | null;
  title: string | null;
  payment_intent: string | null;
  origin_location: string | null;
  payout_id: string | null;
}

export interface ContactRow {
  contact_id: string;
  name: string | null;
  company: string | null;
  address: string | null;
  tags_json: string | null;
}

export interface LedgerLine {
  id: string;
  date: string;              // YYYY-MM-DD in the location timezone
  segment: string;
  space: string;
  type: string;
  payer: string;
  title: string;
  method: string;
  gross: number;             // cents
  fee: number;
  net: number;
  payoutId: string | null;
  depositDate: string | null;
  flag: string;
  own?: boolean;             // paid by one of the owner's own companies (confirmed or suspected)
  source: string;
}
