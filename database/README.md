# Database Schema - Free Tarot Fun

## Files

- `schema.sql` - Complete database schema for fresh installation
- `../migrations/` - Incremental migration files

## How to Use

### Fresh Installation (New Supabase Project)

1. Go to Supabase Dashboard → SQL Editor
2. Copy and paste the entire contents of `schema.sql`
3. Execute

### Migration from Existing Server

1. Export your current data if needed
2. Run `schema.sql` on new Supabase project
3. Import data

## Tables

| Table | Description |
|-------|-------------|
| `subscription_plans` | Available subscription plans (Free, Weekly, Monthly) |
| `payment_transactions` | PayPal payment records |
| `user_subscriptions` | Active user subscriptions (one per user) |
| `chats` | User chat sessions |
| `messages` | Chat messages with tarot cards |

## RPC Functions

| Function | Description |
|----------|-------------|
| `get_user_subscription_info(user_uuid)` | Returns subscription status for a user |
| `save_message(chat_id, user_id, role, content, cards)` | Saves a message to a chat |
| `get_chat_history(chat_id)` | Returns all messages in a chat |
| `get_chat_list(user_id)` | Returns all chats for a user |
| `delete_chat(chat_id, user_id)` | Deletes a chat |
| `update_chat_title(chat_id, user_id, title)` | Updates chat title |
| `toggle_favorite(chat_id, user_id)` | Toggles favorite status |

## Environment Variables Required

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```
