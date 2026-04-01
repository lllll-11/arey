const { google } = require('googleapis');

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/integrations/google/callback';
}

function getOauthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET');
  }

  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

function buildGoogleAuthUrl() {
  const oauth2Client = getOauthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = getOauthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getRedirectUri,
};
