-- Migration: Payment Subscriptions Schema
-- Run this in Supabase SQL Editor

-- 1. Add columns to payment_transactions if they don't exist
ALTER TABLE payment_transactions
ADD COLUMN IF NOT EXISTS plan_id BIGINT REFERENCES subscription_plans(id),
ADD COLUMN IF NOT EXISTS paypal_capture_id TEXT,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 2. Create user_subscriptions table
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id BIGINT REFERENCES subscription_plans(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  subscription_start_date TIMESTAMPTZ,
  subscription_end_date TIMESTAMPTZ,
  payment_transaction_id UUID REFERENCES payment_transactions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 3. Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_status ON payment_transactions(user_id, status);

-- 4. Enable RLS on user_subscriptions
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for user_subscriptions
DROP POLICY IF EXISTS "Users can view own subscription" ON user_subscriptions;
CREATE POLICY "Users can view own subscription" ON user_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can do everything (for backend operations)
DROP POLICY IF EXISTS "Service role full access" ON user_subscriptions;
CREATE POLICY "Service role full access" ON user_subscriptions
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- 6. Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_subscriptions_updated_at ON user_subscriptions;
CREATE TRIGGER update_user_subscriptions_updated_at
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 7. Update the get_user_subscription_info function
DROP FUNCTION IF EXISTS get_user_subscription_info(UUID);
CREATE OR REPLACE FUNCTION get_user_subscription_info(p_user_uuid UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'has_active_subscription',
    CASE
      WHEN us.status = 'active' AND us.subscription_end_date > NOW() THEN true
      ELSE false
    END,
    'plan_name', sp.name,
    'plan_id', us.plan_id,
    'questions_remaining',
    CASE
      WHEN us.status = 'active' AND us.subscription_end_date > NOW() THEN COALESCE(sp.questions_limit, 999)
      ELSE 0
    END,
    'subscription_start_date', us.subscription_start_date,
    'subscription_end_date', us.subscription_end_date,
    'can_ask_question',
    CASE
      WHEN us.status = 'active' AND us.subscription_end_date > NOW() THEN true
      ELSE false
    END,
    'subscription_status', us.status
  )
  INTO result
  FROM user_subscriptions us
  LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
  WHERE us.user_id = p_user_uuid;

  -- Return default if no subscription found
  IF result IS NULL THEN
    result := json_build_object(
      'has_active_subscription', false,
      'plan_name', null,
      'plan_id', null,
      'questions_remaining', 0,
      'subscription_start_date', null,
      'subscription_end_date', null,
      'can_ask_question', false,
      'subscription_status', null
    );
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
