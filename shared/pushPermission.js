export async function requestPushPermission(notificationApi) {
  if (!notificationApi) return 'unsupported'
  if (notificationApi.permission === 'granted') return 'granted'
  return notificationApi.requestPermission()
}
