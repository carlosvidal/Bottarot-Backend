-- =============================================
-- Migration 003: User Memory System
-- Adds cross-session memory for personalized tarot readings
-- =============================================

-- =============================================
-- 1. USER MEMORY TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS user_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN (
        'recurring_theme',
        'life_event',
        'relationship',
        'preference',
        'identity'
    )),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    layer TEXT NOT NULL DEFAULT 'emotional' CHECK (layer IN ('identity', 'emotional')),
    source_chat_id UUID,
    ttl_days INT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, category, key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memory_expires ON user_memory(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================
-- 2. TRIGGER: Auto-calculate expires_at from ttl_days
-- =============================================

CREATE OR REPLACE FUNCTION set_memory_expiry()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ttl_days IS NOT NULL THEN
        NEW.expires_at := NEW.created_at + (NEW.ttl_days || ' days')::INTERVAL;
    ELSE
        NEW.expires_at := NULL;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_memory_expiry ON user_memory;
CREATE TRIGGER trigger_set_memory_expiry
BEFORE INSERT OR UPDATE ON user_memory
FOR EACH ROW EXECUTE FUNCTION set_memory_expiry();

-- =============================================
-- 3. RPC: get_user_memory_context
-- Returns formatted text with non-expired memory entries for a user
-- =============================================

CREATE OR REPLACE FUNCTION get_user_memory_context(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    memory_text TEXT := '';
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT category, key, value, layer, confidence
        FROM user_memory
        WHERE user_id = p_user_id
        AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY
            CASE layer WHEN 'identity' THEN 0 ELSE 1 END,
            confidence DESC,
            updated_at DESC
        LIMIT 20
    LOOP
        memory_text := memory_text || '- ' || rec.value || E'\n';
    END LOOP;

    RETURN NULLIF(TRIM(memory_text), '');
END;
$$;

-- =============================================
-- 4. RPC: save_memory_entry
-- Upserts a memory entry (updates on conflict with same user/category/key)
-- =============================================

CREATE OR REPLACE FUNCTION save_memory_entry(
    p_user_id UUID,
    p_category TEXT,
    p_key TEXT,
    p_value TEXT,
    p_confidence FLOAT DEFAULT 1.0,
    p_layer TEXT DEFAULT 'emotional',
    p_source_chat_id UUID DEFAULT NULL,
    p_ttl_days INT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO user_memory (user_id, category, key, value, confidence, layer, source_chat_id, ttl_days)
    VALUES (p_user_id, p_category, p_key, p_value, p_confidence, p_layer, p_source_chat_id, p_ttl_days)
    ON CONFLICT (user_id, category, key)
    DO UPDATE SET
        value = EXCLUDED.value,
        confidence = GREATEST(user_memory.confidence, EXCLUDED.confidence),
        source_chat_id = COALESCE(EXCLUDED.source_chat_id, user_memory.source_chat_id),
        ttl_days = EXCLUDED.ttl_days,
        updated_at = NOW()
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- =============================================
-- 5. RPC: cleanup_expired_memories
-- Deletes expired memory entries, returns count of deleted rows
-- Can be called by a cron job or Supabase Edge Function
-- =============================================

CREATE OR REPLACE FUNCTION cleanup_expired_memories()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INT;
BEGIN
    DELETE FROM user_memory
    WHERE expires_at IS NOT NULL AND expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- =============================================
-- 6. ROW LEVEL SECURITY
-- =============================================

ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;

-- Users can view their own memory entries
CREATE POLICY "Users can view own memory"
    ON user_memory FOR SELECT
    USING (auth.uid() = user_id);

-- Users can delete their own memory entries
CREATE POLICY "Users can delete own memory"
    ON user_memory FOR DELETE
    USING (auth.uid() = user_id);

-- Service role has full access (for backend operations)
CREATE POLICY "Service role full access to memory"
    ON user_memory FOR ALL
    USING (auth.role() = 'service_role');
