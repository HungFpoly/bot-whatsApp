# How to Get WhatsApp Business API Credentials

## Prerequisites
- You already have a WhatsApp Business Account linked to the bot number
- A Meta/Facebook Business Account

## Step 1: Go to Meta for Developers
- Open: https://developers.facebook.com/
- Sign in with your Facebook account

## Step 2: Create or Select App
- Click "My Apps" (top right)
- If no app exists, click "Create App"
- Choose app type: "Business" (not Consumer)
- Fill in app details:
  - App Name: "Laguna Park Bot"
  - App Contact Email: your email
  - App Purpose: "Messaging / Communications"
- Click "Create App"

## Step 3: Add WhatsApp Product
- Go to "Products" (left sidebar)
- Search for "WhatsApp"
- Click "WhatsApp" → "Set Up"
- Follow setup wizard

## Step 4: Get Your WhatsApp Business Account ID
- Go to "Dashboard"
- Under WhatsApp → "Getting Started"
- You'll see: **WhatsApp Business Account ID** (copy this)

## Step 5: Get Phone Number ID
- Go to WhatsApp → "Configuration"
- Under "Phone Numbers", you'll see your bot number
- Click on it → Copy the **Phone Number ID**

## Step 6: Generate Access Token
**Option A: Temporary Token (for testing)**
- Go to WhatsApp → "API Setup"
- Under "Access Tokens", click "Generate Token"
- Copy the token (valid for ~1 hour)

**Option B: Permanent Token (for production)**
- Go to your app settings → "Basic"
- Under "App Roles", click "Add Roles"
- Create/select a System User
- Go back to "App Roles"
- Assign role: "Business analyst" (or higher)
- Go to System Users → click your user → "Generate Token"
- Select permissions: `whatsapp_business_messaging`, `whatsapp_business_account_access`
- Token is now permanent (until revoked)

## Step 7: Get Your Business Phone Number ID (alternative method)
```bash
curl -X GET "https://graph.instagram.com/v18.0/YOUR_BUSINESS_ACCOUNT_ID/phone_numbers?access_token=YOUR_ACCESS_TOKEN"
```

This returns:
```json
{
  "data": [
    {
      "id": "123456789",
      "display_phone_number": "+65 9728 8416",
      "phone_number": "+6597288416"
    }
  ]
}
```

- `id` = Phone Number ID (use in API calls)
- `phone_number` = actual WhatsApp number

## Step 8: Save Credentials
Add to `.env`:
```
WHATSAPP_BUSINESS_PHONE_ID=123456789
WHATSAPP_BUSINESS_ACCESS_TOKEN=EAA...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
```

## Step 9: Test API Call
```bash
curl -X POST "https://graph.instagram.com/v18.0/PHONE_NUMBER_ID/messages?access_token=ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "6591234567",
    "type": "text",
    "text": { "body": "Hello!" }
  }'
```

## Important URLs
- Developers: https://developers.facebook.com/
- App Dashboard: https://developers.facebook.com/apps/
- WhatsApp API Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/

## Notes
- Access tokens have expiration dates (check in app settings)
- Keep tokens secret - never commit to git
- Test tokens expire after 1 hour
- Production tokens can be set to never expire (but can be revoked)

---

**Next Step:**
Once you have credentials (PHONE_ID, ACCESS_TOKEN, ACCOUNT_ID), share them so we can update the code to use official WhatsApp Business API instead of Baileys.
