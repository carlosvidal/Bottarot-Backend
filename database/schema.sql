-- ============================================
-- BOTTAROT DATABASE SCHEMA
-- Complete schema for Supabase PostgreSQL
-- Last updated: 2026-01-25
-- Version: 2.0 - Subscription Restructure
-- ============================================
--
-- For the subscription restructure migration, run:
-- migrations/002_subscription_restructure.sql
-- ============================================

-- ============================================
-- 1. SUBSCRIPTION PLANS
-- ============================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  description TEXT,
  max_questions_per_period INTEGER DEFAULT 999,
  features JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true
);

-- Sample plans
INSERT INTO subscription_plans (name, price, duration_days, description, max_questions_per_period, features, is_active) VALUES
  ('Gratuito', 0, 7, '1 pregunta por semana, para siempre', 1, '{"basic_reading": true, "history_limit": 5}', true),
  ('Semana de Lanzamiento', 1, 7, 'Acceso ilimitado por 7 días - Precio especial de lanzamiento', 999, '{"unlimited_questions": true, "history_limit": 100, "priority_support": false}', true),
  ('Premium Mensual', 9.99, 30, 'Acceso ilimitado por 30 días', 999, '{"unlimited_questions": true, "history_limit": 999, "priority_support": true}', true)
ON CONFLICT DO NOTHING;

-- ============================================
-- 2. PAYMENT TRANSACTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id UUID,
  paypal_payment_id TEXT,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  plan_id BIGINT REFERENCES subscription_plans(id),
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method TEXT DEFAULT 'paypal',
  transaction_data JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_id ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_paypal_order ON payment_transactions(paypal_order_id);

-- RLS for payment_transactions
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own transactions" ON payment_transactions;
CREATE POLICY "Users can view own transactions" ON payment_transactions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on transactions" ON payment_transactions;
CREATE POLICY "Service role full access on transactions" ON payment_transactions
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 3. USER SUBSCRIPTIONS
-- ============================================
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

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);

-- RLS for user_subscriptions
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own subscription" ON user_subscriptions;
CREATE POLICY "Users can view own subscription" ON user_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on subscriptions" ON user_subscriptions;
CREATE POLICY "Service role full access on subscriptions" ON user_subscriptions
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Trigger to update updated_at
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

-- ============================================
-- 4. CHATS
-- ============================================
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  is_favorite BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);

-- RLS for chats
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own chats" ON chats;
CREATE POLICY "Users can manage own chats" ON chats
  FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- 5. MESSAGES
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT,
  cards JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);

-- RLS for messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own messages" ON messages;
CREATE POLICY "Users can manage own messages" ON messages
  FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- 6. RPC FUNCTIONS
-- ============================================

-- Get user subscription info
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
      WHEN us.status = 'active' AND us.subscription_end_date > NOW() THEN COALESCE(sp.max_questions_per_period, 999)
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

-- Save message RPC
DROP FUNCTION IF EXISTS save_message(UUID, UUID, TEXT, TEXT, JSONB);
CREATE OR REPLACE FUNCTION save_message(
  p_chat_id UUID,
  p_user_id UUID,
  p_role TEXT,
  p_content TEXT,
  p_cards JSONB DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO messages (chat_id, user_id, role, content, cards)
  VALUES (p_chat_id, p_user_id, p_role, p_content, p_cards);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get chat history RPC
DROP FUNCTION IF EXISTS get_chat_history(UUID);
CREATE OR REPLACE FUNCTION get_chat_history(p_chat_id UUID)
RETURNS TABLE (
  id UUID,
  role TEXT,
  content TEXT,
  cards JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.role, m.content, m.cards, m.created_at
  FROM messages m
  WHERE m.chat_id = p_chat_id
  ORDER BY m.created_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get chat list RPC
DROP FUNCTION IF EXISTS get_chat_list(UUID);
CREATE OR REPLACE FUNCTION get_chat_list(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  title TEXT,
  is_favorite BOOLEAN,
  created_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.is_favorite,
    c.created_at,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id) as last_message_at
  FROM chats c
  WHERE c.user_id = p_user_id
  ORDER BY is_favorite DESC, last_message_at DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete chat RPC
DROP FUNCTION IF EXISTS delete_chat(UUID, UUID);
CREATE OR REPLACE FUNCTION delete_chat(p_chat_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  DELETE FROM chats
  WHERE id = p_chat_id AND user_id = p_user_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update chat title RPC
DROP FUNCTION IF EXISTS update_chat_title(UUID, UUID, TEXT);
CREATE OR REPLACE FUNCTION update_chat_title(p_chat_id UUID, p_user_id UUID, p_title TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE chats
  SET title = p_title
  WHERE id = p_chat_id AND user_id = p_user_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Toggle favorite RPC
DROP FUNCTION IF EXISTS toggle_favorite(UUID, UUID);
CREATE OR REPLACE FUNCTION toggle_favorite(p_chat_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  new_favorite BOOLEAN;
BEGIN
  UPDATE chats
  SET is_favorite = NOT is_favorite
  WHERE id = p_chat_id AND user_id = p_user_id
  RETURNING is_favorite INTO new_favorite;

  RETURN new_favorite;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
