-- ============================================
-- MIGRATION: 004_shared_chats.sql
-- Feature: Public sharing of tarot readings
-- Date: 2026-02-05
-- ============================================

-- ============================================
-- 1. SHARED CHATS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS shared_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id VARCHAR(12) UNIQUE NOT NULL,  -- nanoid corto: "r5Kx2mP9qL"
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Datos copiados para no depender del chat original
  title TEXT NOT NULL,
  question TEXT,
  cards JSONB NOT NULL,
  interpretation_summary TEXT,  -- Sintesis para OG description

  -- Preview image
  preview_image_url TEXT,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 year'),
  view_count INTEGER DEFAULT 0
);

-- ============================================
-- 2. INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_shared_chats_share_id ON shared_chats(share_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_user_id ON shared_chats(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_chat_id ON shared_chats(chat_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_expires_at ON shared_chats(expires_at);

-- ============================================
-- 3. ROW LEVEL SECURITY
-- ============================================
ALTER TABLE shared_chats ENABLE ROW LEVEL SECURITY;

-- Public read access for non-expired shares
DROP POLICY IF EXISTS "Anyone can read non-expired shares" ON shared_chats;
CREATE POLICY "Anyone can read non-expired shares" ON shared_chats
  FOR SELECT USING (expires_at > NOW());

-- Owner can insert
DROP POLICY IF EXISTS "Owner can insert shares" ON shared_chats;
CREATE POLICY "Owner can insert shares" ON shared_chats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Owner can delete their shares
DROP POLICY IF EXISTS "Owner can delete shares" ON shared_chats;
CREATE POLICY "Owner can delete shares" ON shared_chats
  FOR DELETE USING (auth.uid() = user_id);

-- Service role full access
DROP POLICY IF EXISTS "Service role full access on shared_chats" ON shared_chats;
CREATE POLICY "Service role full access on shared_chats" ON shared_chats
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 4. RPC FUNCTIONS
-- ============================================

-- Get shared reading with messages (public access)
DROP FUNCTION IF EXISTS get_shared_reading(VARCHAR);
CREATE OR REPLACE FUNCTION get_shared_reading(p_share_id VARCHAR)
RETURNS JSON AS $$
DECLARE
  result JSON;
  share_record shared_chats%ROWTYPE;
BEGIN
  -- Get the share record
  SELECT * INTO share_record
  FROM shared_chats
  WHERE share_id = p_share_id
    AND expires_at > NOW();

  IF share_record.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Build result with share data and messages
  SELECT json_build_object(
    'share', json_build_object(
      'id', share_record.id,
      'share_id', share_record.share_id,
      'title', share_record.title,
      'question', share_record.question,
      'cards', share_record.cards,
      'interpretation_summary', share_record.interpretation_summary,
      'preview_image_url', share_record.preview_image_url,
      'created_at', share_record.created_at,
      'view_count', share_record.view_count
    ),
    'messages', (
      SELECT COALESCE(json_agg(
        json_build_object(
          'id', m.id,
          'role', m.role,
          'content', m.content,
          'cards', m.cards,
          'created_at', m.created_at
        ) ORDER BY m.created_at
      ), '[]'::json)
      FROM messages m
      WHERE m.chat_id = share_record.chat_id
    )
  ) INTO result;

  -- Increment view counter (async-safe)
  UPDATE shared_chats
  SET view_count = view_count + 1
  WHERE share_id = p_share_id;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if chat already has a share
DROP FUNCTION IF EXISTS get_existing_share(UUID);
CREATE OR REPLACE FUNCTION get_existing_share(p_chat_id UUID)
RETURNS TABLE (
  share_id VARCHAR,
  preview_image_url TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT sc.share_id, sc.preview_image_url, sc.created_at
  FROM shared_chats sc
  WHERE sc.chat_id = p_chat_id
    AND sc.expires_at > NOW()
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a new share
DROP FUNCTION IF EXISTS create_share(VARCHAR, UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT);
CREATE OR REPLACE FUNCTION create_share(
  p_share_id VARCHAR,
  p_chat_id UUID,
  p_user_id UUID,
  p_title TEXT,
  p_question TEXT,
  p_cards JSONB,
  p_interpretation_summary TEXT,
  p_preview_image_url TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  INSERT INTO shared_chats (
    share_id,
    chat_id,
    user_id,
    title,
    question,
    cards,
    interpretation_summary,
    preview_image_url
  ) VALUES (
    p_share_id,
    p_chat_id,
    p_user_id,
    p_title,
    p_question,
    p_cards,
    p_interpretation_summary,
    p_preview_image_url
  )
  RETURNING json_build_object(
    'share_id', share_id,
    'created_at', created_at
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. GRANT PERMISSIONS
-- ============================================
-- Allow anon users to read shared content via RPC
GRANT EXECUTE ON FUNCTION get_shared_reading(VARCHAR) TO anon;
GRANT EXECUTE ON FUNCTION get_shared_reading(VARCHAR) TO authenticated;
