-- ============================================
-- BOTTAROT REFERRAL SYSTEM
-- Migration: 005_referral_system.sql
-- ============================================

-- 1. Tabla de códigos de referido (uno por usuario)
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code VARCHAR(12) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);

-- 2. Tabla de referidos (tracking)
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_code VARCHAR(12) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  reward_type VARCHAR(20),
  reward_amount INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- 3. Agregar campo bonus_readings a user_reading_stats
ALTER TABLE user_reading_stats
ADD COLUMN IF NOT EXISTS bonus_readings INTEGER DEFAULT 0;

-- 4. RLS Policies
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own referral code" ON referral_codes;
DROP POLICY IF EXISTS "Users can create own referral code" ON referral_codes;
DROP POLICY IF EXISTS "Referrers can view their referrals" ON referrals;
DROP POLICY IF EXISTS "Service role full access to referral_codes" ON referral_codes;
DROP POLICY IF EXISTS "Service role full access to referrals" ON referrals;

-- Códigos: usuario puede ver/crear el suyo
CREATE POLICY "Users can view own referral code" ON referral_codes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own referral code" ON referral_codes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role needs full access for backend operations
CREATE POLICY "Service role full access to referral_codes" ON referral_codes
  FOR ALL USING (auth.role() = 'service_role');

-- Referrals: referrer puede ver sus referidos
CREATE POLICY "Referrers can view their referrals" ON referrals
  FOR SELECT USING (auth.uid() = referrer_id);

-- Service role needs full access for backend operations
CREATE POLICY "Service role full access to referrals" ON referrals
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- 5. RPC: Obtener o crear código de referido
-- ============================================
DROP FUNCTION IF EXISTS get_or_create_referral_code(UUID);
CREATE OR REPLACE FUNCTION get_or_create_referral_code(p_user_id UUID)
RETURNS VARCHAR AS $$
DECLARE
  v_code VARCHAR(12);
BEGIN
  -- Buscar código existente
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;

  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  -- Generar nuevo código (fallback si no se genera desde backend)
  v_code := upper(substring(md5(random()::text) from 1 for 10));

  INSERT INTO referral_codes (user_id, code)
  VALUES (p_user_id, v_code)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING code INTO v_code;

  -- Si hubo conflicto, obtener el existente
  IF v_code IS NULL THEN
    SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;
  END IF;

  RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. RPC: Registrar referido (llamado al signup)
-- ============================================
DROP FUNCTION IF EXISTS register_referral(UUID, VARCHAR);
CREATE OR REPLACE FUNCTION register_referral(
  p_referred_id UUID,
  p_referral_code VARCHAR
)
RETURNS BOOLEAN AS $$
DECLARE
  v_referrer_id UUID;
BEGIN
  -- Buscar quién es el referrer
  SELECT user_id INTO v_referrer_id
  FROM referral_codes
  WHERE code = p_referral_code;

  IF v_referrer_id IS NULL THEN
    RETURN FALSE;  -- Código inválido
  END IF;

  -- No auto-referirse
  IF v_referrer_id = p_referred_id THEN
    RETURN FALSE;
  END IF;

  -- Insertar referral (pending)
  INSERT INTO referrals (referrer_id, referred_id, referral_code, status)
  VALUES (v_referrer_id, p_referred_id, p_referral_code, 'pending')
  ON CONFLICT (referred_id) DO NOTHING;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. RPC: Completar referido y otorgar reward
-- ============================================
DROP FUNCTION IF EXISTS complete_referral_reward(UUID);
CREATE OR REPLACE FUNCTION complete_referral_reward(p_referred_id UUID)
RETURNS JSON AS $$
DECLARE
  v_referral referrals%ROWTYPE;
  v_subscription_id UUID;
  v_plan_type TEXT;
  v_reward_type VARCHAR(20);
  v_reward_amount INTEGER;
  v_interval INTERVAL;
BEGIN
  -- Buscar referral pendiente
  SELECT * INTO v_referral
  FROM referrals
  WHERE referred_id = p_referred_id AND status = 'pending';

  IF v_referral IS NULL THEN
    RETURN json_build_object('success', false, 'reason', 'no_pending_referral');
  END IF;

  -- Buscar suscripción activa del referrer con su plan_type
  SELECT s.id, sp.plan_type
  INTO v_subscription_id, v_plan_type
  FROM subscriptions s
  JOIN subscription_plans sp ON s.plan_id = sp.id
  WHERE s.user_id = v_referral.referrer_id
    AND s.status = 'active'
    AND s.ends_at > NOW()
  ORDER BY s.ends_at DESC
  LIMIT 1;

  IF v_subscription_id IS NOT NULL THEN
    -- Usuario Premium: reward según plan_type
    v_reward_type := 'subscription_days';

    -- Determinar días según el plan_type
    CASE v_plan_type
      WHEN 'trial' THEN
        -- Plan $1 (Ritual de Iniciación)
        v_reward_amount := 1;
        v_interval := INTERVAL '1 day';
      WHEN 'annual' THEN
        -- Plan Anual
        v_reward_amount := 30;
        v_interval := INTERVAL '30 days';
      ELSE
        -- Plan mensual ($8) - 'standard' u otro
        v_reward_amount := 8;
        v_interval := INTERVAL '8 days';
    END CASE;

    -- Extender suscripción
    UPDATE subscriptions
    SET ends_at = ends_at + v_interval
    WHERE id = v_subscription_id;
  ELSE
    -- Usuario Free: +5 lecturas
    v_reward_type := 'bonus_readings';
    v_reward_amount := 5;

    -- Agregar lecturas bonus
    INSERT INTO user_reading_stats (user_id, bonus_readings)
    VALUES (v_referral.referrer_id, 5)
    ON CONFLICT (user_id)
    DO UPDATE SET bonus_readings = user_reading_stats.bonus_readings + 5;
  END IF;

  -- Marcar como rewarded
  UPDATE referrals
  SET status = 'rewarded',
      reward_type = v_reward_type,
      reward_amount = v_reward_amount,
      completed_at = NOW(),
      rewarded_at = NOW()
  WHERE id = v_referral.id;

  RETURN json_build_object(
    'success', true,
    'referrer_id', v_referral.referrer_id,
    'reward_type', v_reward_type,
    'reward_amount', v_reward_amount
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. RPC: Obtener estadísticas de referidos
-- ============================================
DROP FUNCTION IF EXISTS get_referral_stats(UUID);
CREATE OR REPLACE FUNCTION get_referral_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  v_code VARCHAR(12);
  v_total_referrals INTEGER;
  v_completed_referrals INTEGER;
  v_total_rewards JSON;
BEGIN
  -- Obtener código
  SELECT code INTO v_code FROM referral_codes WHERE user_id = p_user_id;

  -- Contar referidos
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'rewarded')
  INTO v_total_referrals, v_completed_referrals
  FROM referrals WHERE referrer_id = p_user_id;

  -- Calcular rewards totales
  SELECT json_build_object(
    'bonus_readings', COALESCE(SUM(reward_amount) FILTER (WHERE reward_type = 'bonus_readings'), 0),
    'subscription_days', COALESCE(SUM(reward_amount) FILTER (WHERE reward_type = 'subscription_days'), 0)
  ) INTO v_total_rewards
  FROM referrals
  WHERE referrer_id = p_user_id AND status = 'rewarded';

  RETURN json_build_object(
    'code', v_code,
    'total_referrals', v_total_referrals,
    'completed_referrals', v_completed_referrals,
    'total_rewards', v_total_rewards
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
