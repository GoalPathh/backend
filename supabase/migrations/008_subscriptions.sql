-- Subscriptions table: tracks each user's current plan tier and effective period.
-- One row per user (PRIMARY KEY on user_id). Missing row => free tier handled in app.
CREATE TYPE subscription_tier AS ENUM ('free', 'premium');
CREATE TYPE subscription_status AS ENUM ('pending', 'active', 'expired', 'cancelled');

CREATE TABLE public.subscriptions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier subscription_tier NOT NULL DEFAULT 'free',
  status subscription_status NOT NULL DEFAULT 'active',
  current_period_start timestamptz,
  current_period_end timestamptz,
  auto_renew boolean NOT NULL DEFAULT false,
  last_payment_order_id text,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_tier_status ON public.subscriptions(tier, status);
CREATE INDEX idx_subscriptions_period_end ON public.subscriptions(current_period_end);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own subscription" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Payment transactions: full audit log of Midtrans Snap transactions.
CREATE TABLE public.payment_transactions (
  order_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gross_amount numeric(12,2) NOT NULL,
  status text NOT NULL,
  payment_type text,
  transaction_id text,
  snap_token text,
  signature_match boolean,
  fraud_status text,
  raw_notification jsonb,
  tier subscription_tier NOT NULL DEFAULT 'premium',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_transactions_user_id ON public.payment_transactions(user_id);
CREATE INDEX idx_payment_transactions_user_status ON public.payment_transactions(user_id, status);

ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own payment transactions" ON public.payment_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- updated_at trigger (reuse function from 003 if it exists, otherwise create)
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_payment_transactions_updated_at ON public.payment_transactions;
CREATE TRIGGER trg_payment_transactions_updated_at
  BEFORE UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.subscriptions IS
  'Current subscription tier per user. Treat missing row as free tier.';
COMMENT ON TABLE public.payment_transactions IS
  'Audit log for Midtrans Snap transactions. Used to power billing history and webhook traceability.';
