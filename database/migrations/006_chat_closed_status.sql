-- Migration: Add is_closed field to chats table
-- Allows users to finalize/close a reading permanently

-- Add is_closed column to chats table
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT false;

-- Create index for filtering closed chats
CREATE INDEX IF NOT EXISTS idx_chats_is_closed ON chats(is_closed);

-- Function to close a chat (finalize a reading)
CREATE OR REPLACE FUNCTION close_chat(p_chat_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE chats
    SET is_closed = true
    WHERE id = p_chat_id AND user_id = p_user_id;
    RETURN FOUND;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION close_chat(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION close_chat(UUID, UUID) TO service_role;
