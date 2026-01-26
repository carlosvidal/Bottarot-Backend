-- ============================================
-- Migration: Subscription System Restructure
-- Version: 002
-- Description: New tiered subscription system with reading stats,
--              promotional offers, and future card visibility control
-- Run this in Supabase SQL Editor
-- ============================================

-- ============================================
-- 1. USER READING STATS TABLE
-- Tracks daily readings and free future reveals
-- ============================================
CREATE TABLE IF NOT EXISTS user_reading_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  readings_today INTEGER DEFAULT 0,
  last_reading_date DATE,
  free_futures_used INTEGER DEFAULT 0,
  registration_date TIMESTAMPTZ DEFAULT NOW(),
  total_readings INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_reading_stats_user_id ON user_reading_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_reading_stats_last_reading ON user_reading_stats(last_reading_date);

-- RLS for user_reading_stats
ALTER TABLE user_reading_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own reading stats" ON user_reading_stats;
CREATE POLICY "Users can view own reading stats" ON user_reading_stats
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on reading stats" ON user_reading_stats;
CREATE POLICY "Service role full access on reading stats" ON user_reading_stats
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 2. USER PROMOTIONAL OFFERS TABLE
-- Tracks trial/promotional plan usage and cooldowns
-- ============================================
CREATE TABLE IF NOT EXISTS user_promotional_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  offer_type TEXT NOT NULL,
  first_shown_at TIMESTAMPTZ,
  last_shown_at TIMESTAMPTZ,
  times_shown INTEGER DEFAULT 0,
  purchased_at TIMESTAMPTZ,
  cooldown_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, offer_type)
);

CREATE INDEX IF NOT EXISTS idx_user_promo_offers_user_id ON user_promotional_offers(user_id);
CREATE INDEX IF NOT EXISTS idx_user_promo_offers_type ON user_promotional_offers(offer_type);

-- RLS for user_promotional_offers
ALTER TABLE user_promotional_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own promo offers" ON user_promotional_offers;
CREATE POLICY "Users can view own promo offers" ON user_promotional_offers
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on promo offers" ON user_promotional_offers;
CREATE POLICY "Service role full access on promo offers" ON user_promotional_offers
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 3. MODIFY SUBSCRIPTION PLANS TABLE
-- Add new columns for plan types and promotions
-- ============================================
ALTER TABLE subscription_plans
ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS is_promotional BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS cooldown_days INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS badge_text TEXT;

-- ============================================
-- 4. MODIFY MESSAGES TABLE
-- Add future_revealed column for visibility tracking
-- ============================================
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS future_revealed BOOLEAN DEFAULT true;

-- ============================================
-- 5. DEACTIVATE OLD PLANS AND INSERT NEW ONES
-- ============================================

-- Deactivate all existing plans
UPDATE subscription_plans SET is_active = false;

-- Insert new subscription plans
INSERT INTO subscription_plans (
  name, price, duration_days, description, max_questions_per_period,
  features, is_active, plan_type, is_promotional, cooldown_days,
  display_order, badge_text
) VALUES
-- Free Plan
(
  'Gratuito',
  0,
  36500, -- ~100 years (lifetime)
  '1 lectura por día. 5 primeros futuros gratis.',
  1,
  '{"daily_readings": 1, "free_futures": 5, "history_limit": 3}'::jsonb,
  true,
  'free',
  false,
  0,
  0,
  null
),
-- Trial Plan (Ritual de Iniciación)
(
  'Ritual de Iniciación',
  1,
  7,
  'Explora tu destino sin límites durante 7 días.',
  999,
  '{"unlimited_readings": true, "full_future": true, "full_history": true}'::jsonb,
  true,
  'trial',
  true,
  14, -- 14 day cooldown after purchase
  1,
  'OFERTA ESPECIAL'
),
-- Monthly Plan (Most Popular)
(
  'Pase Mensual',
  8,
  30,
  'Sigue tu camino sin interrupciones.',
  999,
  '{"unlimited_readings": true, "full_future": true, "full_history": true}'::jsonb,
  true,
  'standard',
  false,
  0,
  2,
  'MÁS POPULAR'
),
-- Annual Plan (Best Value)
(
  'Pase Anual',
  64,
  365,
  'Un año completo para entender tu camino.',
  999,
  '{"unlimited_readings": true, "full_future": true, "full_history": true, "priority_support": true}'::jsonb,
  true,
  'annual',
  false,
  0,
  3,
  'MEJOR VALOR'
)
ON CONFLICT DO NOTHING;

-- ============================================
-- 6. RPC FUNCTION: GET USER READING PERMISSIONS
-- Returns comprehensive reading permissions for a user
-- ============================================
DROP FUNCTION IF EXISTS get_user_reading_permissions(UUID);
CREATE OR REPLACE FUNCTION get_user_reading_permissions(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
  v_is_premium BOOLEAN := false;
  v_can_read_today BOOLEAN := true;
  v_can_see_future BOOLEAN := false;
  v_readings_today INTEGER := 0;
  v_days_since_registration INTEGER := 0;
  v_free_futures_remaining INTEGER := 5;
  v_free_futures_used INTEGER := 0;
  v_total_readings INTEGER := 0;
  v_history_limit INTEGER := 3;
  v_subscription_end_date TIMESTAMPTZ;
  v_plan_name TEXT := 'Gratuito';
BEGIN
  -- Check for active premium subscription
  SELECT
    CASE WHEN us.status = 'active' AND us.subscription_end_date > NOW() THEN true ELSE false END,
    us.subscription_end_date,
    sp.name
  INTO v_is_premium, v_subscription_end_date, v_plan_name
  FROM user_subscriptions us
  LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
  WHERE us.user_id = p_user_id;

  -- If premium, they have all permissions
  IF v_is_premium THEN
    RETURN json_build_object(
      'is_premium', true,
      'can_read_today', true,
      'can_see_future', true,
      'readings_today', 0,
      'days_since_registration', v_days_since_registration,
      'free_futures_remaining', 0,
      'free_futures_used', 0,
      'total_readings', 0,
      'history_limit', 999,
      'plan_name', COALESCE(v_plan_name, 'Premium'),
      'subscription_end_date', v_subscription_end_date
    );
  END IF;

  -- Get or create reading stats for free user
  INSERT INTO user_reading_stats (user_id, readings_today, last_reading_date, free_futures_used, total_readings)
  VALUES (p_user_id, 0, NULL, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Get current reading stats
  SELECT
    COALESCE(urs.readings_today, 0),
    COALESCE(urs.free_futures_used, 0),
    COALESCE(urs.total_readings, 0),
    EXTRACT(DAY FROM NOW() - urs.registration_date)::INTEGER,
    urs.last_reading_date
  INTO v_readings_today, v_free_futures_used, v_total_readings, v_days_since_registration
  FROM user_reading_stats urs
  WHERE urs.user_id = p_user_id;

  -- Reset daily readings if it's a new day
  IF v_readings_today > 0 THEN
    SELECT
      CASE WHEN last_reading_date < CURRENT_DATE THEN 0 ELSE readings_today END
    INTO v_readings_today
    FROM user_reading_stats
    WHERE user_id = p_user_id;
  END IF;

  -- Calculate remaining free futures
  v_free_futures_remaining := GREATEST(0, 5 - COALESCE(v_free_futures_used, 0));

  -- Free users: 1 reading per day
  v_can_read_today := (v_readings_today < 1);

  -- Can see future if: within first 5 futures OR premium
  v_can_see_future := (v_free_futures_remaining > 0);

  RETURN json_build_object(
    'is_premium', false,
    'can_read_today', v_can_read_today,
    'can_see_future', v_can_see_future,
    'readings_today', v_readings_today,
    'days_since_registration', COALESCE(v_days_since_registration, 0),
    'free_futures_remaining', v_free_futures_remaining,
    'free_futures_used', COALESCE(v_free_futures_used, 0),
    'total_readings', COALESCE(v_total_readings, 0),
    'history_limit', v_history_limit,
    'plan_name', 'Gratuito',
    'subscription_end_date', null
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. RPC FUNCTION: RECORD READING
-- Records a reading and updates stats
-- ============================================
DROP FUNCTION IF EXISTS record_user_reading(UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION record_user_reading(
  p_user_id UUID,
  p_revealed_future BOOLEAN DEFAULT false
)
RETURNS JSON AS $$
DECLARE
  v_readings_today INTEGER;
  v_free_futures_used INTEGER;
  v_total_readings INTEGER;
BEGIN
  -- Insert or update reading stats
  INSERT INTO user_reading_stats (
    user_id,
    readings_today,
    last_reading_date,
    free_futures_used,
    total_readings
  )
  VALUES (
    p_user_id,
    1,
    CURRENT_DATE,
    CASE WHEN p_revealed_future THEN 1 ELSE 0 END,
    1
  )
  ON CONFLICT (user_id) DO UPDATE SET
    readings_today = CASE
      WHEN user_reading_stats.last_reading_date < CURRENT_DATE THEN 1
      ELSE user_reading_stats.readings_today + 1
    END,
    last_reading_date = CURRENT_DATE,
    free_futures_used = CASE
      WHEN p_revealed_future THEN user_reading_stats.free_futures_used + 1
      ELSE user_reading_stats.free_futures_used
    END,
    total_readings = user_reading_stats.total_readings + 1
  RETURNING readings_today, free_futures_used, total_readings
  INTO v_readings_today, v_free_futures_used, v_total_readings;

  RETURN json_build_object(
    'success', true,
    'readings_today', v_readings_today,
    'free_futures_used', v_free_futures_used,
    'total_readings', v_total_readings
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. RPC FUNCTION: CHECK PROMOTIONAL OFFER ELIGIBILITY
-- Checks if user is eligible for a promotional offer
-- ============================================
DROP FUNCTION IF EXISTS check_promo_eligibility(UUID, TEXT);
CREATE OR REPLACE FUNCTION check_promo_eligibility(
  p_user_id UUID,
  p_offer_type TEXT
)
RETURNS JSON AS $$
DECLARE
  v_is_eligible BOOLEAN := true;
  v_cooldown_ends TIMESTAMPTZ;
  v_times_purchased INTEGER := 0;
  v_reason TEXT := null;
BEGIN
  -- Check if user has ever purchased this offer
  SELECT
    purchased_at IS NOT NULL,
    cooldown_ends_at,
    times_shown
  INTO v_is_eligible, v_cooldown_ends, v_times_purchased
  FROM user_promotional_offers
  WHERE user_id = p_user_id AND offer_type = p_offer_type;

  -- Never purchased = eligible
  IF NOT FOUND THEN
    RETURN json_build_object(
      'is_eligible', true,
      'cooldown_ends_at', null,
      'times_purchased', 0,
      'reason', null
    );
  END IF;

  -- Check if still in cooldown
  IF v_cooldown_ends IS NOT NULL AND v_cooldown_ends > NOW() THEN
    RETURN json_build_object(
      'is_eligible', false,
      'cooldown_ends_at', v_cooldown_ends,
      'times_purchased', v_times_purchased,
      'reason', 'cooldown_active'
    );
  END IF;

  -- Cooldown expired = eligible again
  RETURN json_build_object(
    'is_eligible', true,
    'cooldown_ends_at', v_cooldown_ends,
    'times_purchased', v_times_purchased,
    'reason', null
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. RPC FUNCTION: RECORD PROMOTIONAL PURCHASE
-- Records when a user purchases a promotional plan
-- ============================================
DROP FUNCTION IF EXISTS record_promo_purchase(UUID, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION record_promo_purchase(
  p_user_id UUID,
  p_offer_type TEXT,
  p_cooldown_days INTEGER DEFAULT 14
)
RETURNS JSON AS $$
DECLARE
  v_cooldown_ends TIMESTAMPTZ;
BEGIN
  v_cooldown_ends := NOW() + (p_cooldown_days || ' days')::INTERVAL;

  INSERT INTO user_promotional_offers (
    user_id,
    offer_type,
    first_shown_at,
    last_shown_at,
    times_shown,
    purchased_at,
    cooldown_ends_at
  )
  VALUES (
    p_user_id,
    p_offer_type,
    NOW(),
    NOW(),
    1,
    NOW(),
    v_cooldown_ends
  )
  ON CONFLICT (user_id, offer_type) DO UPDATE SET
    purchased_at = NOW(),
    cooldown_ends_at = v_cooldown_ends,
    times_shown = user_promotional_offers.times_shown + 1;

  RETURN json_build_object(
    'success', true,
    'cooldown_ends_at', v_cooldown_ends
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. UPDATE GET CHAT HISTORY TO INCLUDE FUTURE_REVEALED
-- ============================================
DROP FUNCTION IF EXISTS get_chat_history(UUID);
CREATE OR REPLACE FUNCTION get_chat_history(p_chat_id UUID)
RETURNS TABLE (
  message_id UUID,
  role TEXT,
  content TEXT,
  cards JSONB,
  future_revealed BOOLEAN,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id as message_id, m.role, m.content, m.cards, COALESCE(m.future_revealed, true), m.created_at
  FROM messages m
  WHERE m.chat_id = p_chat_id
  ORDER BY m.created_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 11. UPDATE SAVE MESSAGE TO INCLUDE FUTURE_REVEALED
-- ============================================
DROP FUNCTION IF EXISTS save_message(UUID, UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS save_message(UUID, UUID, TEXT, TEXT, JSONB, BOOLEAN);
CREATE OR REPLACE FUNCTION save_message(
  p_chat_id UUID,
  p_user_id UUID,
  p_role TEXT,
  p_content TEXT,
  p_cards JSONB DEFAULT NULL,
  p_future_revealed BOOLEAN DEFAULT true
)
RETURNS UUID AS $$
DECLARE
  new_message_id UUID;
BEGIN
  INSERT INTO messages (chat_id, user_id, role, content, cards, future_revealed)
  VALUES (p_chat_id, p_user_id, p_role, p_content, p_cards, p_future_revealed)
  RETURNING id INTO new_message_id;

  RETURN new_message_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- VERIFICATION QUERIES (run manually to verify)
-- ============================================
-- SELECT * FROM user_reading_stats LIMIT 5;
-- SELECT * FROM user_promotional_offers LIMIT 5;
-- SELECT name, price, plan_type, badge_text, is_active FROM subscription_plans ORDER BY display_order;
-- SELECT get_user_reading_permissions('your-user-uuid-here');
