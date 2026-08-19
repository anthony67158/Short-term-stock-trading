function clean(value) {
  return String(value || '').trim()
}

export function storedAccountSession(nick, token) {
  const account = clean(nick)
  const sessionToken = clean(token)
  return account && sessionToken
    ? { nick: account, token: sessionToken }
    : null
}

export function parseStoredAccountSession(value) {
  const nick = clean(value?.nick)
  const token = clean(value?.token)
  if (nick && token) {
    return {
      credentials: { nick, token },
      legacyPassword: false,
    }
  }
  const pw = String(value?.pw || '')
  if (nick && pw) {
    return {
      credentials: { nick, pw },
      legacyPassword: true,
    }
  }
  return null
}

export function accountCredentialPayload(credentials) {
  const nick = clean(credentials?.nick)
  const token = clean(credentials?.token)
  if (nick && token) return { nick, token }
  const pw = String(credentials?.pw || '')
  return nick && pw ? { nick, pw } : null
}

export function accountCredentialHeaders(credentials) {
  const payload = accountCredentialPayload(credentials)
  if (!payload) return {}
  const headers = {
    'X-Account-Nick': encodeURIComponent(payload.nick),
  }
  if (payload.token) {
    headers['X-Account-Token'] = encodeURIComponent(payload.token)
  } else {
    headers['X-Account-Password'] = encodeURIComponent(payload.pw)
  }
  return headers
}
