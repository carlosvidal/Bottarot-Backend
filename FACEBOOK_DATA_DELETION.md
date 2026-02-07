# Facebook Data Deletion Callback

Facebook requires apps using Facebook Login to provide a **Data Deletion Callback URL**. This endpoint is called when a user requests deletion of their data from Facebook's settings.

## Setup

### 1. Environment Variable

Add your Facebook App Secret to `.env`:

```
FACEBOOK_APP_SECRET=your_facebook_app_secret
```

You can find it in **Facebook Developer Console → Settings → Basic → App Secret**.

### 2. Facebook Developer Console

Go to **Facebook Developer Console → Settings → Data Deletion** and set:

- **Data Deletion Callback URL:** `https://your-backend-domain.com/api/facebook/data-deletion`

## Endpoints

### `POST /api/facebook/data-deletion`

Called by Facebook when a user requests data deletion. Receives a `signed_request` parameter in the body.

**Flow:**
1. Verifies the HMAC-SHA256 signature using `FACEBOOK_APP_SECRET`
2. Extracts the Facebook user ID from the payload
3. Looks up the corresponding Supabase user via `auth.identities`
4. Deletes the user with `supabase.auth.admin.deleteUser()` — all related data (chats, messages, subscriptions, payments, referrals) is removed via `ON DELETE CASCADE`
5. Returns a confirmation code and status URL

**Response:**
```json
{
  "url": "https://freetarot.fun/deletion-status?code=abc123...",
  "confirmation_code": "abc123..."
}
```

### `GET /api/facebook/deletion-status`

Status check endpoint. Returns a static confirmation that the data has been deleted.

**Response:**
```json
{
  "status": "complete",
  "message": "Your data has been deleted from FreeTarot.Fun. This action is irreversible."
}
```

## Testing

1. Set `FACEBOOK_APP_SECRET` in your `.env`
2. Use the **"Test Data Deletion"** button in the Facebook App Dashboard
3. Check server logs for `[Facebook Data Deletion]` entries
4. Verify the user is removed from Supabase Auth dashboard
